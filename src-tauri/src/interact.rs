//! Input for the transparent window, kept separate from painting.
//!
//! The window is always a full rectangle. Nothing here sets a window region, so
//! glow, labels, and panels are never clipped. The page is the source of the
//! shapes that should receive the pointer (the main circle, each visible child
//! circle and its label, and any open panel). Those shapes arrive in logical
//! pixels; this module stores them in physical pixels using the window scale.
//!
//! The window starts in click-through mode (`set_ignore_cursor_events(true)`),
//! so empty space goes to whatever is behind it. A short cursor poll tests the
//! shapes. Entering one turns capture on and tells the page; leaving turns
//! capture off again so the page can start its collapse delay. A press that
//! begins on a shape keeps capture until the button is released, which is what
//! makes dragging the main sphere work. File drags are not that press: the
//! button is already down, so capture follows the shapes only, and the drop
//! target reports copy while the cursor is on the main circle. While the
//! sphere glides to an edge, input is suspended and the window stays in
//! passthrough.

#![cfg_attr(windows, allow(unsafe_code))]

#[derive(serde::Deserialize)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub round: bool,
    /// The main sphere. File drops are accepted only on this circle.
    #[serde(default)]
    pub main: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum InputPhase {
    #[default]
    Passthrough,
    HoverCapture,
    PointerHeld,
    Suspended,
}

impl InputPhase {
    #[cfg_attr(not(windows), allow(dead_code))]
    pub const fn captures(self) -> bool {
        matches!(self, Self::HoverCapture | Self::PointerHeld)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct PollSample {
    pub hit: bool,
    pub lbutton_down: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Transition {
    pub prev: InputPhase,
    pub next: InputPhase,
}

impl Transition {
    #[cfg_attr(not(windows), allow(dead_code))]
    pub const fn capture_changed(self) -> Option<bool> {
        let prev = self.prev.captures();
        let next = self.next.captures();
        if prev == next { None } else { Some(next) }
    }
}

#[derive(Debug, Default)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct InputMachine {
    pub phase: InputPhase,
    pub hold: bool,
    pub suspended: bool,
    pub press_ours: bool,
    pub was_down: bool,
    pub button_up_ticks: u8,
}

impl InputMachine {
    #[cfg_attr(not(windows), allow(dead_code))]
    pub const fn new() -> Self {
        Self {
            phase: InputPhase::Passthrough,
            hold: false,
            suspended: false,
            press_ours: false,
            was_down: false,
            button_up_ticks: 0,
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn step(&mut self, sample: PollSample) -> Transition {
        let prev = self.phase;

        // Only a press that starts on a shape belongs to us. A file drag from
        // Explorer already has the button down, so it must not pin the window.
        if sample.lbutton_down && !self.was_down && sample.hit {
            self.press_ours = true;
        }
        if !sample.lbutton_down {
            self.press_ours = false;
        }
        self.was_down = sample.lbutton_down;

        if self.hold && !sample.lbutton_down {
            self.button_up_ticks = self.button_up_ticks.saturating_add(1);
            if self.button_up_ticks >= 2 {
                self.hold = false;
                self.button_up_ticks = 0;
            }
        } else {
            self.button_up_ticks = 0;
        }

        // A snap glide owns the window until it settles. Keep clicks passing
        // through instead of treating the moving sphere as a hit target.
        self.phase = if self.suspended {
            InputPhase::Suspended
        } else if self.hold || self.press_ours {
            InputPhase::PointerHeld
        } else if sample.hit {
            InputPhase::HoverCapture
        } else {
            InputPhase::Passthrough
        };

        Transition {
            prev,
            next: self.phase,
        }
    }
}

#[tauri::command]
pub fn set_hit_rects(
    window: tauri::WebviewWindow,
    rects: Vec<HitRect>,
    generation: u64,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::apply_hit_rects(&window, &rects, generation)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, rects, generation);
        Ok(())
    }
}

#[tauri::command]
pub fn set_pointer_hold(hold: bool) {
    #[cfg(windows)]
    win::set_hold(hold);
    #[cfg(not(windows))]
    let _ = hold;
}

#[tauri::command]
pub fn set_input_suspended(window: tauri::WebviewWindow, suspended: bool) {
    #[cfg(windows)]
    win::set_suspended(&window, suspended);
    #[cfg(not(windows))]
    let _ = (window, suspended);
}

#[cfg(windows)]
pub fn start(app: &tauri::AppHandle) {
    win::start(app);
}

#[cfg(windows)]
mod win {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, MutexGuard};
    use std::thread;
    use std::time::Duration;

    use tauri::{AppHandle, Emitter, Manager};
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, POINTL, RECT, TRUE};
    use windows::Win32::Graphics::Gdi::{ClientToScreen, ScreenToClient};
    use windows::Win32::System::Com::{DVASPECT_CONTENT, FORMATETC, IDataObject, TYMED_HGLOBAL};
    use windows::Win32::System::Ole::{
        CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE, IDropTarget, IDropTarget_Impl,
        RegisterDragDrop, RevokeDragDrop,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows::Win32::UI::Shell::{DragAcceptFiles, DragFinish, DragQueryFileW, HDROP};
    use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetCursorPos, GetWindowRect};
    use windows_core::implement;

    use super::{HitRect, InputMachine, PollSample};

    const POLL_NEAR: Duration = Duration::from_millis(30);
    const POLL_FAR: Duration = Duration::from_millis(100);
    const NEAR_MARGIN: i32 = 64;

    struct HitBox {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
        round: bool,
        main: bool,
    }

    struct HitState {
        generation: u64,
        boxes: Vec<HitBox>,
        input: InputMachine,
    }

    static HIT: Mutex<HitState> = Mutex::new(HitState {
        generation: 0,
        boxes: Vec::new(),
        input: InputMachine::new(),
    });
    static STARTED: AtomicBool = AtomicBool::new(false);

    fn lock() -> MutexGuard<'static, HitState> {
        HIT.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub fn start(app: &AppHandle) {
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(window) = app.get_webview_window("main") else {
            STARTED.store(false, Ordering::SeqCst);
            return;
        };
        let Ok(hwnd) = window.hwnd() else {
            STARTED.store(false, Ordering::SeqCst);
            return;
        };
        // Passthrough until the cursor is actually on a published shape.
        let _ = window.set_ignore_cursor_events(true);
        register_drop_targets(hwnd, app);

        let app = app.clone();
        // HWND is a raw pointer and is not Send. The poll thread only reads it.
        let hwnd_bits = hwnd.0 as isize;
        if thread::Builder::new()
            .name("powersphere-cursor".into())
            .spawn(move || poll_cursor(hwnd_bits, app))
            .is_err()
        {
            STARTED.store(false, Ordering::SeqCst);
        }
    }

    pub fn apply_hit_rects(
        window: &tauri::WebviewWindow,
        rects: &[HitRect],
        generation: u64,
    ) -> Result<(), String> {
        let scale = window.scale_factor().map_err(|err| err.to_string())?;
        if !(scale.is_finite() && scale > 0.0) {
            return Err("缩放无效".into());
        }
        start(window.app_handle());
        update_hits(rects, scale, generation);
        Ok(())
    }

    fn update_hits(rects: &[HitRect], scale: f64, generation: u64) -> bool {
        let mut state = lock();
        if generation < state.generation {
            return false;
        }
        state.generation = generation;
        state.boxes.clear();
        state.boxes.reserve(rects.len());
        for rect in rects {
            let left = (rect.x * scale).round() as i32;
            let top = (rect.y * scale).round() as i32;
            let right = ((rect.x + rect.w) * scale).round() as i32;
            let bottom = ((rect.y + rect.h) * scale).round() as i32;
            if right <= left || bottom <= top {
                continue;
            }
            state.boxes.push(HitBox {
                left,
                top,
                right,
                bottom,
                round: rect.round,
                main: rect.main,
            });
        }
        true
    }

    pub fn set_hold(hold: bool) {
        lock().input.hold = hold;
    }

    pub fn set_suspended(window: &tauri::WebviewWindow, suspended: bool) {
        lock().input.suspended = suspended;
        if !suspended {
            return;
        }
        let app = window.app_handle().clone();
        let app_for_ui = app.clone();
        let _ = app.run_on_main_thread(move || {
            if !lock().input.suspended {
                return;
            }
            if let Some(window) = app_for_ui.get_webview_window("main") {
                let _ = window.set_ignore_cursor_events(true);
            }
        });
    }

    fn poll_cursor(hwnd_bits: isize, app: AppHandle) {
        let hwnd = HWND(hwnd_bits as *mut std::ffi::c_void);
        let mut captured = false;
        lock().input.was_down = lbutton_down();

        loop {
            let near = cursor_near_window(hwnd);
            thread::sleep(if near || captured {
                POLL_NEAR
            } else {
                POLL_FAR
            });

            let Some((x, y)) = client_cursor(hwnd) else {
                continue;
            };
            let down = lbutton_down();
            let transition = {
                let mut state = lock();
                let hit = state.boxes.iter().any(|shape| contains(shape, x, y));
                state.input.step(PollSample {
                    hit,
                    lbutton_down: down,
                })
            };

            let Some(want) = transition.capture_changed() else {
                continue;
            };
            let app_for_ui = app.clone();
            let queued = app.run_on_main_thread(move || {
                if let Some(window) = app_for_ui.get_webview_window("main") {
                    let _ = window.set_ignore_cursor_events(!want);
                }
            });
            if queued.is_err() {
                break;
            }
            captured = want;
            let _ = app.emit("powersphere://hover", HoverEvent { inside: want });
        }
    }

    fn over_main(x: i32, y: i32) -> bool {
        let state = lock();
        state
            .boxes
            .iter()
            .any(|shape| shape.main && contains(shape, x, y))
    }

    fn contains(shape: &HitBox, x: i32, y: i32) -> bool {
        if shape.round {
            let rx = (shape.right - shape.left) / 2;
            let ry = (shape.bottom - shape.top) / 2;
            if rx <= 0 || ry <= 0 {
                return false;
            }
            let dx = (x - (shape.left + shape.right) / 2) as f64 / rx as f64;
            let dy = (y - (shape.top + shape.bottom) / 2) as f64 / ry as f64;
            dx * dx + dy * dy <= 1.0
        } else {
            x >= shape.left && x < shape.right && y >= shape.top && y < shape.bottom
        }
    }

    fn lbutton_down() -> bool {
        unsafe { GetAsyncKeyState(i32::from(VK_LBUTTON.0)) < 0 }
    }

    fn client_cursor(hwnd: HWND) -> Option<(i32, i32)> {
        unsafe {
            let mut cursor = POINT::default();
            GetCursorPos(&mut cursor).ok()?;
            let mut origin = POINT::default();
            if !ClientToScreen(hwnd, &mut origin).as_bool() {
                return None;
            }
            Some((cursor.x - origin.x, cursor.y - origin.y))
        }
    }

    fn cursor_near_window(hwnd: HWND) -> bool {
        unsafe {
            let mut cursor = POINT::default();
            if GetCursorPos(&mut cursor).is_err() {
                return true;
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_err() {
                return true;
            }
            cursor.x >= rect.left - NEAR_MARGIN
                && cursor.x < rect.right + NEAR_MARGIN
                && cursor.y >= rect.top - NEAR_MARGIN
                && cursor.y < rect.bottom + NEAR_MARGIN
        }
    }

    #[derive(Clone, serde::Serialize)]
    struct HoverEvent {
        inside: bool,
    }

    fn register_drop_targets(hwnd: HWND, app: &AppHandle) {
        register_drop_target(hwnd, app);
        unsafe {
            let pointer = app as *const AppHandle;
            let _ = EnumChildWindows(Some(hwnd), Some(register_child), LPARAM(pointer as isize));
            DragAcceptFiles(hwnd, true);
        }
    }

    unsafe extern "system" fn register_child(child: HWND, param: LPARAM) -> windows_core::BOOL {
        unsafe {
            let app = &*(param.0 as *const AppHandle);
            register_drop_target(child, app);
        }
        TRUE
    }

    fn register_drop_target(hwnd: HWND, app: &AppHandle) {
        let target: IDropTarget = FileDrop::new(app.clone(), hwnd).into();
        unsafe {
            let _ = RevokeDragDrop(hwnd);
            if RegisterDragDrop(hwnd, &target).is_ok() {
                std::mem::forget(target);
            }
        }
    }

    #[derive(Clone, serde::Serialize)]
    struct FileDragEvent {
        kind: &'static str,
        paths: Vec<String>,
        x: f64,
        y: f64,
    }

    #[implement(IDropTarget)]
    struct FileDrop {
        app: AppHandle,
        hwnd: HWND,
        files: AtomicBool,
    }

    impl FileDrop {
        fn new(app: AppHandle, hwnd: HWND) -> Self {
            Self {
                app,
                hwnd,
                files: AtomicBool::new(false),
            }
        }

        fn client_point(&self, pt: &POINTL) -> (i32, i32) {
            let mut point = POINT { x: pt.x, y: pt.y };
            unsafe {
                let _ = ScreenToClient(self.hwnd, &mut point);
            }
            (point.x, point.y)
        }

        fn effect_at(&self, pt: &POINTL, has_files: bool) -> DROPEFFECT {
            let (x, y) = self.client_point(pt);
            if has_files && over_main(x, y) {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            }
        }

        fn emit(&self, kind: &'static str, paths: Vec<String>, x: i32, y: i32) {
            let _ = self.app.emit(
                "powersphere://file-drag",
                FileDragEvent {
                    kind,
                    paths,
                    x: f64::from(x),
                    y: f64::from(y),
                },
            );
        }
    }

    #[allow(non_snake_case)]
    impl IDropTarget_Impl for FileDrop_Impl {
        fn DragEnter(
            &self,
            data: windows_core::Ref<'_, IDataObject>,
            _keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows_core::Result<()> {
            let paths = file_paths(data);
            let has_files = !paths.is_empty();
            self.files.store(has_files, Ordering::Relaxed);
            unsafe {
                *effect = self.effect_at(pt, has_files);
            }
            if has_files {
                let (x, y) = self.client_point(pt);
                self.emit("enter", paths, x, y);
            }
            Ok(())
        }

        fn DragOver(
            &self,
            _keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows_core::Result<()> {
            unsafe {
                *effect = self.effect_at(pt, self.files.load(Ordering::Relaxed));
            }
            let (x, y) = self.client_point(pt);
            self.emit("over", Vec::new(), x, y);
            Ok(())
        }

        fn DragLeave(&self) -> windows_core::Result<()> {
            self.emit("leave", Vec::new(), 0, 0);
            Ok(())
        }

        fn Drop(
            &self,
            data: windows_core::Ref<'_, IDataObject>,
            _keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows_core::Result<()> {
            let paths = file_paths(data);
            unsafe {
                *effect = self.effect_at(pt, !paths.is_empty());
            }
            let (x, y) = self.client_point(pt);
            self.emit("drop", paths, x, y);
            Ok(())
        }
    }

    fn file_paths(data: windows_core::Ref<'_, IDataObject>) -> Vec<String> {
        let Some(data) = data.as_ref() else {
            return Vec::new();
        };
        unsafe {
            let format = FORMATETC {
                cfFormat: CF_HDROP.0,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            };
            let Ok(medium) = data.GetData(&format) else {
                return Vec::new();
            };
            let hdrop = HDROP(medium.u.hGlobal.0 as _);
            let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
            let mut paths = Vec::with_capacity(count as usize);
            for index in 0..count {
                let length = DragQueryFileW(hdrop, index, None) as usize;
                let mut buffer = vec![0u16; length + 1];
                DragQueryFileW(hdrop, index, Some(&mut buffer));
                paths.push(String::from_utf16_lossy(&buffer[..length]));
            }
            DragFinish(hdrop);
            paths
        }
    }
}

#[cfg(test)]
mod input_phase_tests {
    use super::{InputMachine, InputPhase, PollSample};

    #[test]
    fn hover_enter_and_leave_toggle_capture() {
        let mut machine = InputMachine::new();
        assert_eq!(machine.phase, InputPhase::Passthrough);

        let enter = machine.step(PollSample {
            hit: true,
            lbutton_down: false,
        });
        assert_eq!(enter.next, InputPhase::HoverCapture);
        assert_eq!(enter.capture_changed(), Some(true));

        let stay = machine.step(PollSample {
            hit: true,
            lbutton_down: false,
        });
        assert_eq!(stay.next, InputPhase::HoverCapture);
        assert_eq!(stay.capture_changed(), None);

        let leave = machine.step(PollSample {
            hit: false,
            lbutton_down: false,
        });
        assert_eq!(leave.next, InputPhase::Passthrough);
        assert_eq!(leave.capture_changed(), Some(false));
    }

    #[test]
    fn press_starting_on_shape_keeps_capture_until_release() {
        let mut machine = InputMachine::new();
        machine.step(PollSample {
            hit: true,
            lbutton_down: false,
        });

        let press = machine.step(PollSample {
            hit: true,
            lbutton_down: true,
        });
        assert_eq!(press.next, InputPhase::PointerHeld);
        assert_eq!(press.capture_changed(), None);

        let drag_off = machine.step(PollSample {
            hit: false,
            lbutton_down: true,
        });
        assert_eq!(drag_off.next, InputPhase::PointerHeld);
        assert_eq!(drag_off.capture_changed(), None);

        let release = machine.step(PollSample {
            hit: false,
            lbutton_down: false,
        });
        assert_eq!(release.next, InputPhase::Passthrough);
        assert_eq!(release.capture_changed(), Some(false));
    }

    #[test]
    fn external_file_drag_does_not_pin_pointer_held() {
        let mut machine = InputMachine::new();
        machine.step(PollSample {
            hit: false,
            lbutton_down: true,
        });

        let enter = machine.step(PollSample {
            hit: true,
            lbutton_down: true,
        });
        assert_eq!(enter.next, InputPhase::HoverCapture);
        assert_eq!(enter.capture_changed(), Some(true));

        let leave = machine.step(PollSample {
            hit: false,
            lbutton_down: true,
        });
        assert_eq!(leave.next, InputPhase::Passthrough);
        assert_eq!(leave.capture_changed(), Some(false));
    }

    #[test]
    fn hold_releases_after_two_button_up_ticks() {
        let mut machine = InputMachine::new();
        machine.hold = true;

        let tick1 = machine.step(PollSample {
            hit: false,
            lbutton_down: false,
        });
        assert_eq!(tick1.next, InputPhase::PointerHeld);
        assert!(machine.hold);
        assert_eq!(machine.button_up_ticks, 1);

        // A button-down tick resets the fallback counter.
        let pressed = machine.step(PollSample {
            hit: false,
            lbutton_down: true,
        });
        assert_eq!(pressed.next, InputPhase::PointerHeld);
        assert_eq!(machine.button_up_ticks, 0);

        let up1 = machine.step(PollSample {
            hit: false,
            lbutton_down: false,
        });
        assert_eq!(up1.next, InputPhase::PointerHeld);
        assert_eq!(machine.button_up_ticks, 1);

        let up2 = machine.step(PollSample {
            hit: false,
            lbutton_down: false,
        });
        assert_eq!(up2.next, InputPhase::Passthrough);
        assert!(!machine.hold);
        assert_eq!(machine.button_up_ticks, 0);
        assert_eq!(up2.capture_changed(), Some(false));
    }

    #[test]
    fn suspended_forces_passthrough_and_resumes_cleanly() {
        let mut machine = InputMachine::new();
        machine.step(PollSample {
            hit: true,
            lbutton_down: false,
        });

        machine.suspended = true;
        let suspend = machine.step(PollSample {
            hit: true,
            lbutton_down: false,
        });
        assert_eq!(suspend.next, InputPhase::Suspended);
        assert_eq!(suspend.capture_changed(), Some(false));

        machine.suspended = false;
        let resume = machine.step(PollSample {
            hit: true,
            lbutton_down: false,
        });
        assert_eq!(resume.next, InputPhase::HoverCapture);
        assert_eq!(resume.capture_changed(), Some(true));
    }
}
