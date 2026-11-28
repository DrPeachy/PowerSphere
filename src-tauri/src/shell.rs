use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

static SHELL_EPOCH: AtomicU64 = AtomicU64::new(0);
static SHELL_MOVE: Mutex<()> = Mutex::new(());

fn shell_guard() -> MutexGuard<'static, ()> {
    SHELL_MOVE.lock().unwrap_or_else(|err| err.into_inner())
}

#[derive(serde::Serialize)]
pub struct CursorPoint {
    pub x: f64,
    pub y: f64,
}

#[tauri::command]
pub fn set_shell_bounds(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    preserve_client: bool,
    epoch: u64,
) -> Result<(), String> {
    if !(x.is_finite() && y.is_finite() && width.is_finite() && height.is_finite())
        || width < 1.0
        || height < 1.0
    {
        return Err("窗口尺寸无效".into());
    }
    let _guard = shell_guard();
    if epoch != SHELL_EPOCH.load(Ordering::SeqCst) {
        return Ok(());
    }
    apply_shell_bounds(&window, x, y, width, height, preserve_client)?;
    if !window.is_visible().unwrap_or(false) {
        window.show().map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn cursor_position(window: tauri::WebviewWindow) -> Result<CursorPoint, String> {
    let pos = window.cursor_position().map_err(|err| err.to_string())?;
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    if !(scale.is_finite() && scale > 0.0 && pos.x.is_finite() && pos.y.is_finite()) {
        return Err("无法读取光标位置".into());
    }
    Ok(CursorPoint {
        x: pos.x / scale,
        y: pos.y / scale,
    })
}

/// Slide the window to a logical origin. The page must not move it again.
///
/// `epoch` invalidates drag commands already in flight. The last frame is the
/// exact physical target, not a rounded sample of the ease.
#[tauri::command]
pub fn animate_shell_position(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    duration_ms: u32,
    epoch: u64,
) -> Result<(), String> {
    if !(x.is_finite() && y.is_finite() && width.is_finite() && height.is_finite())
        || width < 1.0
        || height < 1.0
    {
        return Err("窗口尺寸无效".into());
    }
    let duration_ms = duration_ms.clamp(1, 400);
    let _guard = shell_guard();
    SHELL_EPOCH.store(epoch, Ordering::SeqCst);
    #[cfg(windows)]
    {
        animate_position_windows(&window, x, y, width, height, duration_ms)?;
    }
    #[cfg(not(windows))]
    {
        let _ = duration_ms;
        window
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|err| err.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn ease_out_cubic(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

/// Screen pixel along an ease. The finished frame is `to` itself, not a rounded sample.
#[cfg(any(windows, test))]
fn eased_pixel(from: i32, to: i32, t: f64) -> i32 {
    if t >= 1.0 {
        return to;
    }
    (f64::from(from) + (f64::from(to) - f64::from(from)) * ease_out_cubic(t)).round() as i32
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn animate_position_windows(
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    duration_ms: u32,
) -> Result<(), String> {
    use std::thread;
    use std::time::{Duration, Instant};

    use tauri::{LogicalPosition, LogicalSize};
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos,
    };

    fn place(
        hwnd_bits: isize,
        px: i32,
        py: i32,
        pw: i32,
        ph: i32,
        resize: bool,
    ) -> Result<(), String> {
        let hwnd = HWND(hwnd_bits as *mut std::ffi::c_void);
        let flags = if resize {
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS
        } else {
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE
        };
        unsafe {
            SetWindowPos(hwnd, None, px, py, pw, ph, flags).map_err(|err| err.to_string())?;
        }
        Ok(())
    }

    let hwnd = window.hwnd().map_err(|err| err.to_string())?;
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    if !(scale.is_finite() && scale > 0.0) {
        return Err("缩放无效".into());
    }
    let target: tauri::PhysicalPosition<i32> = LogicalPosition::new(x, y).to_physical(scale);
    let target_size: tauri::PhysicalSize<i32> = LogicalSize::new(width, height).to_physical(scale);
    let mut rect = RECT::default();
    unsafe {
        GetWindowRect(hwnd, &mut rect).map_err(|err| err.to_string())?;
    }
    let from_x = rect.left;
    let from_y = rect.top;
    let from_w = rect.right - rect.left;
    let from_h = rect.bottom - rect.top;
    let to_x = target.x;
    let to_y = target.y;
    let to_w = target_size.width;
    let to_h = target_size.height;
    let hwnd_bits = hwnd.0 as isize;
    // One exact move when the page asked for no slide. A real slide keeps the
    // larger box until the last frame so the sphere stays inside the window
    // while its client offset changes edge.
    if duration_ms <= 16 {
        return place(hwnd_bits, to_x, to_y, to_w, to_h, true);
    }
    let slide_w = from_w.max(to_w);
    let slide_h = from_h.max(to_h);
    if slide_w != from_w || slide_h != from_h {
        place(hwnd_bits, from_x, from_y, slide_w, slide_h, true)?;
    }

    let duration = Duration::from_millis(u64::from(duration_ms));
    let frame = Duration::from_millis(16);
    let start = Instant::now();
    let mut placed = (from_x, from_y);
    loop {
        let elapsed = start.elapsed();
        let done = elapsed >= duration;
        let t = if done {
            1.0
        } else {
            elapsed.as_secs_f64() / duration.as_secs_f64()
        };
        let px = eased_pixel(from_x, to_x, t);
        let py = eased_pixel(from_y, to_y, t);
        if (px, py) != placed {
            place(hwnd_bits, px, py, 0, 0, false)?;
            placed = (px, py);
        }
        if done {
            break;
        }
        let steps = u64::try_from(elapsed.as_millis() / 16).unwrap_or(0) + 1;
        let next = Duration::from_millis(steps.saturating_mul(16)).min(duration);
        let elapsed = start.elapsed();
        if next > elapsed {
            thread::sleep(next - elapsed);
        } else {
            thread::sleep(frame);
        }
    }
    if placed != (to_x, to_y) || slide_w != to_w || slide_h != to_h {
        place(hwnd_bits, to_x, to_y, to_w, to_h, true)?;
    }
    Ok(())
}

fn apply_shell_bounds(
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    preserve_client: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        apply_bounds_windows(window, x, y, width, height, preserve_client)
    }
    #[cfg(not(windows))]
    {
        let _ = preserve_client;
        window
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|err| err.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|err| err.to_string())?;
        Ok(())
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn apply_bounds_windows(
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    preserve_client: bool,
) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize};
    use windows::Win32::UI::WindowsAndMessaging::{
        SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOZORDER, SetWindowPos,
    };

    let hwnd = window.hwnd().map_err(|err| err.to_string())?;
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    let position: tauri::PhysicalPosition<i32> = LogicalPosition::new(x, y).to_physical(scale);
    let size: tauri::PhysicalSize<i32> = LogicalSize::new(width, height).to_physical(scale);
    // Resizes copy the old client into the new rect, so the sphere appears to jump until the
    // next paint. Discard those bits only when the size changes; pure drags keep the client.
    let flags = if preserve_client {
        SWP_NOZORDER | SWP_NOACTIVATE
    } else {
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS
    };
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            position.x,
            position.y,
            size.width,
            size.height,
            flags,
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod snap_ease_tests {
    use super::{ease_out_cubic, eased_pixel};

    #[test]
    fn ease_out_cubic_starts_fast_and_finishes_at_one() {
        assert!((ease_out_cubic(0.0) - 0.0).abs() < 1e-9);
        assert!((ease_out_cubic(1.0) - 1.0).abs() < 1e-9);
        assert!(ease_out_cubic(0.4) > 0.4);
    }

    #[test]
    fn final_frame_is_the_target_pixel() {
        assert_eq!(eased_pixel(10, 400, 1.0), 400);
        assert_eq!(eased_pixel(-20, 15, 1.0), 15);
        assert_eq!(eased_pixel(3, 3, 0.4), 3);
    }
}
