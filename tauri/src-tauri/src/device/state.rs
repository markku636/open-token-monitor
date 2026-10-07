//! 裝置狀態：用量與 limits 兩部分合成帶 revision 的 `DeviceRecord`（上游 deviceState.js）。
//!
//! - revision 單調遞增，只跟著 publish 走，不出現在 record 裡（hub 不認得這個鍵）。
//! - limits 在第一筆用量出現前先緩衝：沒有用量的 record 會讓裝置在 hub 上顯示成 0。
//! - limits-only 的 publish 沿用用量的 `updatedAt`，dashboard 的「最後更新」才不會被額度刷新誤導。
//! - history 掃描比用量慢得多（預設 15 分鐘一次），最後一份成功的 history 會帶進之後每一筆 record
//!   （上游 deviceState.js `mergeUsagePart`）：hub 整份取代，少帶一次也不會被清掉，但帶著才保證
//!   新 hub、重建的資料庫都拿得到。history 關閉時每筆都送 `null`。
//! - 開機畫面（`seed`，上游 main.js `primeLocalStatsFromAnchor`）只給畫面看與當預覽的基準：
//!   不佔 revision、不上傳（上游 `skipExport`），limits 也不會拿它組 record。

use std::sync::Arc;

use serde_json::Value;

use crate::wire::{DeviceRecord, Envelope, LimitsSummary, UsageSummary};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordSource {
    Usage,
    Limits,
    History,
}

#[derive(Debug, Clone)]
pub struct Published {
    pub revision: u64,
    pub source: RecordSource,
    pub record: Arc<DeviceRecord>,
}

#[derive(Debug)]
pub struct DeviceState {
    envelope: Envelope,
    sync_upload_interval_ms: u64,
    usage: Option<UsageSummary>,
    limits: Option<LimitsSummary>,
    history: Option<Arc<Value>>,
    revision: u64,
    current: Option<Arc<DeviceRecord>>,
    seed: Option<(UsageSummary, Arc<DeviceRecord>)>,
}

impl DeviceState {
    pub fn new(envelope: Envelope, sync_upload_interval_ms: u64) -> Self {
        DeviceState {
            envelope,
            sync_upload_interval_ms,
            usage: None,
            limits: None,
            history: None,
            revision: 0,
            current: None,
            seed: None,
        }
    }

    /// 開機畫面：上一次完整掃描的錨點。第一筆真正的用量出現後就丟掉。
    pub fn seed(&mut self, summary: UsageSummary) -> Arc<DeviceRecord> {
        let record = Arc::new(DeviceRecord::compose(
            &self.envelope,
            &summary,
            self.sync_upload_interval_ms,
            None,
            None,
        ));
        self.seed = Some((summary, record.clone()));
        record
    }

    /// 預覽的基準：最新的用量，還沒有就用開機畫面（上游 deviceState `hasCompleteUsageBaseline`）。
    pub fn baseline(&self) -> Option<&UsageSummary> {
        self.usage.as_ref().or(self.seed.as_ref().map(|(s, _)| s))
    }

    fn publish(&mut self, source: RecordSource) -> Option<Published> {
        let usage = self.usage.as_ref()?;
        let record = Arc::new(DeviceRecord::compose(
            &self.envelope,
            usage,
            self.sync_upload_interval_ms,
            self.history.as_ref(),
            self.limits.as_ref(),
        ));
        self.revision += 1;
        self.current = Some(record.clone());
        Some(Published {
            revision: self.revision,
            source,
            record,
        })
    }

    pub fn update_usage(&mut self, summary: UsageSummary) -> Published {
        if !summary.history_available {
            self.history = Some(Arc::new(Value::Null));
        } else if self.history.as_deref() == Some(&Value::Null) {
            // 重新打開：等下一次 graph 掃描，不要一直送 null 清掉 hub 上的資料。
            self.history = None;
        }
        self.usage = Some(summary);
        self.seed = None;
        self.publish(RecordSource::Usage)
            .expect("usage was just set")
    }

    /// 新的一份 history（graph 掃描成功）。在第一筆用量之前不發佈，理由同 limits。
    pub fn update_history(&mut self, history: Value) -> Option<Published> {
        self.history = Some(Arc::new(history));
        self.publish(RecordSource::History)
    }

    pub fn update_limits(&mut self, limits: LimitsSummary) -> Option<Published> {
        self.limits = Some(limits);
        self.publish(RecordSource::Limits)
    }

    /// 最新的 record；只有開機畫面時 revision 為 0（上傳端只送 revision 更新的）。
    pub fn snapshot(&self) -> Option<(u64, Arc<DeviceRecord>)> {
        self.current
            .clone()
            .map(|r| (self.revision, r))
            .or_else(|| self.seed.as_ref().map(|(_, r)| (0, r.clone())))
    }

    pub fn envelope(&self) -> &Envelope {
        &self.envelope
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(updated: &str) -> UsageSummary {
        UsageSummary {
            updated_at: updated.into(),
            ..UsageSummary::default()
        }
    }

    #[test]
    fn limits_wait_for_usage_and_keep_its_timestamp() {
        let mut s = DeviceState::new(
            Envelope {
                device_id: "d".into(),
                ..Envelope::default()
            },
            600_000,
        );
        assert!(s.update_limits(LimitsSummary::default()).is_none());
        let p1 = s.update_usage(usage("2026-09-23T00:00:00.000Z"));
        assert_eq!(p1.revision, 1);
        assert!(p1.record.limits.is_some(), "buffered limits are carried");
        let p2 = s
            .update_limits(LimitsSummary {
                refresh_ms: 1,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(p2.revision, 2);
        assert_eq!(p2.source, RecordSource::Limits);
        assert_eq!(p2.record.updated_at, "2026-09-23T00:00:00.000Z");
        assert_eq!(p2.record.sync_upload_interval_ms, 600_000);
        let v = serde_json::to_value(&*p2.record).unwrap();
        assert!(v.get("revision").is_none());
    }

    #[test]
    fn the_owner_email_is_sent_only_when_there_is_one() {
        let mut none = DeviceState::new(Envelope::default(), 0);
        let v = serde_json::to_value(&*none.update_usage(usage("2026-09-23T00:00:00.000Z")).record)
            .unwrap();
        assert!(
            v.get("ownerEmail").is_none(),
            "no key at all: the upload is exactly what it was"
        );

        let mut set = DeviceState::new(
            Envelope::default().with_owner_email("someone@example.test"),
            0,
        );
        let v = serde_json::to_value(&*set.update_usage(usage("2026-09-23T00:00:00.000Z")).record)
            .unwrap();
        assert_eq!(v["ownerEmail"], "someone@example.test");
    }

    #[test]
    fn a_seed_is_shown_but_never_published_or_paired_with_limits() {
        let mut state = DeviceState::new(Envelope::default(), 0);
        let seeded = state.seed(usage("2026-09-24T01:00:00.000Z"));
        assert_eq!(seeded.updated_at, "2026-09-24T01:00:00.000Z");
        assert_eq!(state.snapshot().map(|(rev, _)| rev), Some(0));
        assert!(state.baseline().is_some());
        assert!(state.update_limits(LimitsSummary::default()).is_none());
        let first = state.update_usage(usage("2026-09-24T02:00:00.000Z"));
        assert_eq!(first.revision, 1, "the seed takes no revision");
        assert_eq!(
            state.snapshot().unwrap().1.updated_at,
            "2026-09-24T02:00:00.000Z"
        );
        assert!(state.seed.is_none());
    }

    #[test]
    fn history_is_carried_into_later_records() {
        let mut s = DeviceState::new(Envelope::default(), 0);
        let on = || UsageSummary {
            history_available: true,
            ..usage("2026-09-24T00:00:00.000Z")
        };
        let first = s.update_usage(on());
        assert!(
            first.record.history.is_none(),
            "not scanned yet: omit the key"
        );
        let v = serde_json::to_value(&*first.record).unwrap();
        assert!(v.get("history").is_none());
        assert_eq!(v["historyAvailable"], true);
        let h = s
            .update_history(serde_json::json!({ "daily": [], "monthly": [], "summary": {} }))
            .unwrap();
        assert_eq!(h.source, RecordSource::History);
        let later = s.update_usage(on());
        assert!(later.record.history.as_deref().unwrap().is_object());

        let off = s.update_usage(usage("2026-09-24T00:01:00.000Z"));
        let v = serde_json::to_value(&*off.record).unwrap();
        assert_eq!(
            v["history"],
            serde_json::Value::Null,
            "disabled: explicit null"
        );
        assert_eq!(v["historyAvailable"], false);
        let back_on = s.update_usage(on());
        assert!(back_on.record.history.is_none());
    }
}
