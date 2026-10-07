//! 裝置層：把收集器的產出變成帶 revision 的 record，照上傳節奏交給 hub。

pub mod events;
pub mod runtime;
pub mod sink;
pub mod state;

use std::sync::Arc;

use crate::error::AppError;
use crate::hub::HubClient;
use sink::SendFn;

/// 以 HubClient 包成上傳函式。
pub fn hub_sender(client: HubClient) -> SendFn {
    let client = Arc::new(client);
    Arc::new(move |record| {
        let client = client.clone();
        Box::pin(async move { client.post_record(&record).await.map_err(AppError::from) })
    })
}
