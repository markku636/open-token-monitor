//! tray 圖示的「額度長條」（上游 trayText.js `pickWorstLimitProvider` / `compactLimitSelection`
//! 與 renderer `renderBarsIcon`）。純函式：選出最接近上限的工具，畫成 RGBA 圖。
//!
//! - 上面一條是主要窗口（5 小時；沒有就依序每日、每週、帳單），下面一條是次要窗口（每週或每日）。
//! - 同一種窗口有好幾個（Claude 的「每週」與「每週 Fable」）時取不帶標籤的總量，沒有才取剩最少的。
//! - 長條填滿的是**已用**比例，與 widget 的額度分頁一致（上游預設畫剩餘，可由 `showLimitUsed` 切換）。
//! - 金額型窗口（`metric = credits`）沒有百分比，不畫；Codex 的附加窗口不代表主額度，不選。
//! - 墨色跟著 Windows 工作列：深色工作列用白色，淺色用黑色（上游 `trayGeneratedIconColors`）。

use crate::wire::{LimitProvider, LimitWindow, LimitsSummary, ProviderStatus, WindowKind};

/// 選出的工具與兩條長條的已用百分比（0–100）。
#[derive(Debug, Clone, PartialEq)]
pub struct BarsSelection {
    pub provider: String,
    pub primary_kind: WindowKind,
    pub primary_used: f64,
    pub secondary_kind: Option<WindowKind>,
    pub secondary_used: Option<f64>,
}

fn is_credits(w: &LimitWindow) -> bool {
    w.metric.as_deref() == Some("credits")
}

/// 上游 `limitFillPercent(remaining, used, false)`：剩餘百分比。
fn remaining(w: &LimitWindow) -> Option<f64> {
    if is_credits(w) {
        return None;
    }
    w.remaining_percent
        .or(w.used_percent.map(|u| 100.0 - u))
        .filter(|v| v.is_finite())
}

fn metered(p: &LimitProvider, kind: WindowKind) -> Vec<&LimitWindow> {
    p.windows
        .iter()
        .filter(|w| {
            w.show_meter
                && w.kind == kind
                && !(p.provider == "codex" && w.additional)
                && remaining(w).is_some()
        })
        .collect()
}

fn preferred(p: &LimitProvider, kind: WindowKind) -> Option<&LimitWindow> {
    let windows = metered(p, kind);
    if windows.len() < 2 {
        return windows.first().copied();
    }
    let canonical: &[&str] = match kind {
        WindowKind::Weekly => &["", "weekly"],
        WindowKind::Billing => &["", "total"],
        _ => &[""],
    };
    if let Some(w) = windows
        .iter()
        .find(|w| canonical.contains(&w.label.trim().to_lowercase().as_str()))
    {
        return Some(w);
    }
    windows.into_iter().min_by(|a, b| {
        remaining(a)
            .unwrap_or(100.0)
            .total_cmp(&remaining(b).unwrap_or(100.0))
    })
}

/// 上游 `pickWorstLimitProvider`：每個工具取主要與次要窗口中剩最少的，再取剩最少的工具。
pub fn pick_worst(summary: &LimitsSummary) -> Option<BarsSelection> {
    let mut worst: Option<(f64, BarsSelection)> = None;
    for p in &summary.providers {
        if p.status != ProviderStatus::Ok {
            continue;
        }
        let session = preferred(p, WindowKind::Session);
        let daily = preferred(p, WindowKind::Daily);
        let weekly = preferred(p, WindowKind::Weekly);
        let billing = preferred(p, WindowKind::Billing);
        let Some(primary) = session.or(daily).or(weekly).or(billing) else {
            continue;
        };
        let secondary = if session.is_some() {
            daily.or(weekly)
        } else if daily.is_some() {
            weekly
        } else {
            None
        };
        let left = [Some(primary), secondary]
            .into_iter()
            .flatten()
            .filter_map(remaining)
            .fold(f64::INFINITY, f64::min);
        if worst.as_ref().is_none_or(|(w, _)| left < *w) {
            let used = |w: &LimitWindow| (100.0 - remaining(w).unwrap_or(100.0)).clamp(0.0, 100.0);
            worst = Some((
                left,
                BarsSelection {
                    provider: p.provider.clone(),
                    primary_kind: primary.kind,
                    primary_used: used(primary),
                    secondary_kind: secondary.map(|w| w.kind),
                    secondary_used: secondary.map(used),
                },
            ));
        }
    }
    worst.map(|(_, s)| s)
}

/// 上游 `barsAllSessions`：上面是第一個工具（依 claude、codex 的順序）的 5 小時，下面是第二個的。
/// 只有一個工具有數字時，畫它自己的主要／次要窗口（與 `pick_worst` 同一對）。
pub fn pick_sessions(summary: &LimitsSummary) -> Option<BarsSelection> {
    let mut picks: Vec<(&LimitProvider, &LimitWindow)> = Vec::new();
    for id in ["claude", "codex"] {
        for p in summary.providers.iter().filter(|p| p.provider == id) {
            if p.status != ProviderStatus::Ok {
                continue;
            }
            if let Some(w) = preferred(p, WindowKind::Session) {
                picks.push((p, w));
                break;
            }
        }
    }
    let used = |w: &LimitWindow| (100.0 - remaining(w).unwrap_or(100.0)).clamp(0.0, 100.0);
    match picks.as_slice() {
        [] => None,
        [(p, _)] => pick_worst(&LimitsSummary {
            providers: vec![(*p).clone()],
            ..summary.clone()
        }),
        [(a, wa), (b, wb), ..] => Some(BarsSelection {
            provider: format!("{}+{}", a.provider, b.provider),
            primary_kind: WindowKind::Session,
            primary_used: used(wa),
            secondary_kind: Some(WindowKind::Session),
            secondary_used: Some(used(wb)),
        }),
    }
}

/// `size × size` 的 RGBA：兩條圓角長條，軌道 32% 不透明、已用部分全不透明。
pub fn render_bars(selection: &BarsSelection, size: u32, dark_surface: bool) -> Vec<u8> {
    let ink: u8 = if dark_surface { 255 } else { 0 };
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let s = size as f64;
    let pad_x = (s * 0.09).round() as i64;
    let bar_h = (s * 0.3).round().max(3.0) as i64;
    let gap = (s * 0.12).round().max(1.0) as i64;
    let top = ((s - (2 * bar_h + gap) as f64) / 2.0).round() as i64;
    let width = size as i64 - 2 * pad_x;
    let radius = (bar_h / 3).max(1);
    let mut bar = |y0: i64, used: Option<f64>| {
        let fill_w = used.map_or(0, |u| ((u / 100.0) * width as f64).round() as i64);
        let fill_w = if used.is_some_and(|u| u > 0.0) {
            fill_w.max(1)
        } else {
            fill_w
        };
        for y in y0..y0 + bar_h {
            for x in pad_x..pad_x + width {
                // 四個角各切掉一個小三角，縮到 16 px 時仍看得出是圓角。
                let dx = (x - pad_x).min(pad_x + width - 1 - x);
                let dy = (y - y0).min(y0 + bar_h - 1 - y);
                if dx + dy < radius {
                    continue;
                }
                let alpha: u8 = if x - pad_x < fill_w { 255 } else { 82 };
                let i = ((y * size as i64 + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&[ink, ink, ink, alpha]);
            }
        }
    };
    bar(top, Some(selection.primary_used));
    bar(top + bar_h + gap, selection.secondary_used);
    rgba
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(kind: WindowKind, label: &str, used: f64) -> LimitWindow {
        LimitWindow {
            label: label.into(),
            used_percent: Some(used),
            remaining_percent: Some(100.0 - used),
            ..LimitWindow::new(kind)
        }
    }

    fn provider(id: &str, status: ProviderStatus, windows: Vec<LimitWindow>) -> LimitProvider {
        serde_json::from_value::<LimitProvider>(serde_json::json!({
            "provider": id, "status": "ok", "windows": []
        }))
        .map(|mut p| {
            p.status = status;
            p.windows = windows;
            p
        })
        .unwrap()
    }

    fn summary(providers: Vec<LimitProvider>) -> LimitsSummary {
        LimitsSummary {
            providers,
            ..LimitsSummary::default()
        }
    }

    #[test]
    fn picks_the_tool_closest_to_a_limit_with_its_canonical_windows() {
        let s = summary(vec![
            provider(
                "claude",
                ProviderStatus::Ok,
                vec![
                    window(WindowKind::Session, "", 34.0),
                    window(WindowKind::Weekly, "", 76.0),
                    window(WindowKind::Weekly, "Fable", 92.0),
                ],
            ),
            provider(
                "codex",
                ProviderStatus::Ok,
                vec![
                    window(WindowKind::Session, "", 81.0),
                    window(WindowKind::Weekly, "", 40.0),
                ],
            ),
        ]);
        let pick = pick_worst(&s).unwrap();
        assert_eq!(pick.provider, "codex", "81% beats Claude's canonical 76%");
        assert_eq!(pick.primary_used, 81.0);
        assert_eq!(pick.secondary_used, Some(40.0));
    }

    #[test]
    fn skips_tools_without_fresh_percentages() {
        let mut credits = window(WindowKind::Billing, "Usage credits", 0.0);
        credits.metric = Some("credits".into());
        credits.used_percent = None;
        credits.remaining_percent = None;
        let s = summary(vec![
            provider(
                "claude",
                ProviderStatus::Unauthorized,
                vec![window(WindowKind::Session, "", 99.0)],
            ),
            provider("codex", ProviderStatus::Ok, vec![credits]),
        ]);
        assert!(pick_worst(&s).is_none());
    }

    #[test]
    fn session_bars_stack_one_tool_per_row() {
        let s = summary(vec![
            provider(
                "codex",
                ProviderStatus::Ok,
                vec![
                    window(WindowKind::Session, "", 81.0),
                    window(WindowKind::Weekly, "", 40.0),
                ],
            ),
            provider(
                "claude",
                ProviderStatus::Ok,
                vec![
                    window(WindowKind::Session, "", 34.0),
                    window(WindowKind::Weekly, "", 76.0),
                ],
            ),
        ]);
        let pick = pick_sessions(&s).unwrap();
        assert_eq!(pick.provider, "claude+codex", "fixed order, not wire order");
        assert_eq!((pick.primary_used, pick.secondary_used), (34.0, Some(81.0)));

        let only_claude = summary(vec![provider(
            "claude",
            ProviderStatus::Ok,
            vec![
                window(WindowKind::Session, "", 34.0),
                window(WindowKind::Weekly, "", 76.0),
            ],
        )]);
        let pick = pick_sessions(&only_claude).unwrap();
        assert_eq!(
            pick.secondary_kind,
            Some(WindowKind::Weekly),
            "one tool keeps its own pair"
        );
    }

    #[test]
    fn draws_used_share_in_full_ink() {
        let sel = BarsSelection {
            provider: "claude".into(),
            primary_kind: WindowKind::Session,
            primary_used: 50.0,
            secondary_kind: Some(WindowKind::Weekly),
            secondary_used: Some(0.0),
        };
        let img = render_bars(&sel, 32, true);
        let px = |x: usize, y: usize| &img[(y * 32 + x) * 4..(y * 32 + x) * 4 + 4];
        assert_eq!(px(8, 9), &[255, 255, 255, 255], "used part of the top bar");
        assert_eq!(px(24, 9), &[255, 255, 255, 82], "track of the top bar");
        assert_eq!(px(8, 22)[3], 82, "nothing used in the bottom bar");
        assert_eq!(px(0, 0)[3], 0, "transparent background");
    }
}
