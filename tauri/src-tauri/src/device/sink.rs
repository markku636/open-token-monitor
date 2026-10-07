//! 依序、最新者優先的上傳佇列（上游 src/shared/orderedSink.js）。
//!
//! - 同時最多一筆在傳；傳的期間進來的新 record 只保留最新一筆，舊的直接作廢。
//! - revision 比已見過的最大值小的 record 丟掉（不能讓舊快照蓋掉新的）。
//! - 與上游不同：暫時性錯誤重試 3 次（5 / 15 / 45 秒），除非期間已有更新的 record。
//!   10 分鐘上傳一次時，少傳一筆就是 dashboard 上 20 分鐘的 stale。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::events::{CoreEvent, ErrorInfo, EventSink};
use crate::error::{AppError, AppResult};
use crate::hub::IngestOutcome;
use crate::wire::time::iso_millis;
use crate::wire::DeviceRecord;

pub type SendFuture = Pin<Box<dyn Future<Output = AppResult<IngestOutcome>> + Send>>;
pub type SendFn = Arc<dyn Fn(Arc<DeviceRecord>) -> SendFuture + Send + Sync>;

const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(45),
];

#[derive(Clone)]
struct Pending {
    revision: u64,
    record: Arc<DeviceRecord>,
}

pub struct OrderedSink {
    pending: watch::Sender<Option<Pending>>,
    /// 最後一筆「處理完」（成功、放棄或被取代）的 revision；flush 等它追上。
    done: watch::Receiver<u64>,
    cancel: CancellationToken,
}

fn is_retryable(e: &AppError) -> bool {
    match e {
        AppError::Hub(h) => h.is_retryable(),
        _ => false,
    }
}

impl OrderedSink {
    pub fn start(send: SendFn, events: EventSink, retry_delays: Option<Vec<Duration>>) -> Self {
        let (pending_tx, mut pending_rx) = watch::channel::<Option<Pending>>(None);
        let (done_tx, done_rx) = watch::channel::<u64>(0);
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let delays = retry_delays.unwrap_or_else(|| RETRY_DELAYS.to_vec());
        tokio::spawn(async move {
            let mut last_done = 0u64;
            loop {
                let next = pending_rx.borrow_and_update().clone();
                let Some(entry) = next.filter(|p| p.revision > last_done) else {
                    tokio::select! {
                        changed = pending_rx.changed() => { if changed.is_err() { break; } continue; }
                        _ = stop.cancelled() => break,
                    }
                };
                let mut attempt = 0usize;
                loop {
                    let result = tokio::select! {
                        r = send(entry.record.clone()) => r,
                        _ = stop.cancelled() => { return; }
                    };
                    let now = iso_millis(chrono::Utc::now());
                    match result {
                        Ok(outcome) => {
                            events(CoreEvent::IngestSent {
                                revision: entry.revision,
                                bytes: outcome.bytes,
                                retried: outcome.retried,
                                omissions: outcome.omissions,
                                at: now,
                            });
                            break;
                        }
                        Err(e) => {
                            let newer = pending_rx
                                .borrow()
                                .as_ref()
                                .map(|p| p.revision > entry.revision)
                                .unwrap_or(false);
                            let will_retry = is_retryable(&e) && attempt < delays.len() && !newer;
                            tracing::warn!(revision = entry.revision, error = %e, will_retry, "ingest failed");
                            events(CoreEvent::IngestFailed {
                                revision: entry.revision,
                                error: ErrorInfo::from(&e),
                                will_retry,
                                at: now,
                            });
                            if !will_retry {
                                break;
                            }
                            let delay = delays[attempt];
                            attempt += 1;
                            tokio::select! {
                                _ = tokio::time::sleep(delay) => {}
                                // 等待期間有新 record：放棄舊的，直接送新的。
                                _ = pending_rx.changed() => break,
                                _ = stop.cancelled() => return,
                            }
                        }
                    }
                }
                last_done = entry.revision;
                let _ = done_tx.send(last_done);
            }
        });
        OrderedSink {
            pending: pending_tx,
            done: done_rx,
            cancel,
        }
    }

    /// 排入一筆 record。revision 較舊的會被忽略。
    pub fn enqueue(&self, revision: u64, record: Arc<DeviceRecord>) {
        self.pending.send_if_modified(|slot| {
            if slot
                .as_ref()
                .map(|p| revision <= p.revision)
                .unwrap_or(false)
            {
                return false;
            }
            *slot = Some(Pending { revision, record });
            true
        });
    }

    pub fn highest_enqueued(&self) -> u64 {
        self.pending
            .borrow()
            .as_ref()
            .map(|p| p.revision)
            .unwrap_or(0)
    }

    /// 等到目前排入的最新 record 處理完（成功或放棄）。
    pub async fn flush(&self) {
        let target = self.highest_enqueued();
        let mut done = self.done.clone();
        while *done.borrow_and_update() < target {
            tokio::select! {
                changed = done.changed() => if changed.is_err() { return; },
                _ = self.cancel.cancelled() => return,
            }
        }
    }

    pub fn stop(&self) {
        self.cancel.cancel();
    }
}

impl Drop for OrderedSink {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::payload::PayloadOmissions;
    use crate::hub::HubError;
    use std::sync::Mutex;

    fn record(id: &str) -> Arc<DeviceRecord> {
        let usage = crate::wire::UsageSummary::default();
        let env = crate::wire::Envelope {
            device_id: id.into(),
            ..Default::default()
        };
        Arc::new(DeviceRecord::compose(&env, &usage, 0, None, None))
    }

    fn ok() -> AppResult<IngestOutcome> {
        Ok(IngestOutcome {
            bytes: 1,
            retried: false,
            omissions: PayloadOmissions::default(),
        })
    }

    #[tokio::test]
    async fn sends_first_then_only_latest() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let (s2, g2) = (sent.clone(), gate.clone());
        let send: SendFn = Arc::new(move |r| {
            let s = s2.clone();
            let g = g2.clone();
            Box::pin(async move {
                g.acquire().await.unwrap().forget();
                s.lock().unwrap().push(r.device_id.clone());
                ok()
            })
        });
        let sink = OrderedSink::start(send, crate::device::events::noop_sink(), None);
        sink.enqueue(1, record("r1"));
        tokio::task::yield_now().await;
        sink.enqueue(2, record("r2"));
        sink.enqueue(3, record("r3"));
        sink.enqueue(2, record("stale"));
        gate.add_permits(10);
        sink.flush().await;
        assert_eq!(*sent.lock().unwrap(), vec!["r1", "r3"]);
    }

    #[tokio::test]
    async fn retries_transient_errors_but_not_auth() {
        let calls = Arc::new(Mutex::new(0));
        let c2 = calls.clone();
        let send: SendFn = Arc::new(move |_r| {
            let c = c2.clone();
            Box::pin(async move {
                let mut n = c.lock().unwrap();
                *n += 1;
                if *n < 3 {
                    Err(AppError::Hub(HubError::Server { status: 503 }))
                } else {
                    ok()
                }
            })
        });
        let sink = OrderedSink::start(
            send,
            crate::device::events::noop_sink(),
            Some(vec![Duration::from_millis(1); 3]),
        );
        sink.enqueue(1, record("a"));
        sink.flush().await;
        assert_eq!(*calls.lock().unwrap(), 3);

        let calls = Arc::new(Mutex::new(0));
        let c3 = calls.clone();
        let send: SendFn = Arc::new(move |_r| {
            let c = c3.clone();
            Box::pin(async move {
                *c.lock().unwrap() += 1;
                Err(AppError::Hub(HubError::Unauthorized { status: 401 }))
            })
        });
        let sink = OrderedSink::start(
            send,
            crate::device::events::noop_sink(),
            Some(vec![Duration::from_millis(1); 3]),
        );
        sink.enqueue(1, record("a"));
        sink.flush().await;
        assert_eq!(*calls.lock().unwrap(), 1);
    }
}
