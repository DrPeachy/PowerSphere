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

#![allow(unsafe_code)]

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

pub struct HitShape {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub round: bool,
    pub main: bool,
}

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
    hold: bool,
    boxes: Vec<HitBox>,
}

static HIT: Mutex<HitState> = Mutex::new(HitState {
    generation: 0,
    hold: false,
    boxes: Vec::new(),
});
static STARTED: AtomicBool = AtomicBool::new(false);
static SUSPENDED: AtomicBool = AtomicBool::new(false);

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

pub fn update_hits(rects: &[HitShape], scale: f64, generation: u64) -> bool {
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
    lock().hold = hold;
}

pub fn set_suspended(app: &AppHandle, suspended: bool) {
    SUSPENDED.store(suspended, Ordering::SeqCst);
    if !suspended {
        return;
    }
    let app = app.clone();
    let app_for_ui = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !SUSPENDED.load(Ordering::SeqCst) {
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
    let mut was_down = lbutton_down();
    let mut press_ours = false;
    let mut button_up_ticks = 0u8;

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
        let sample = sample_at(x, y);
        let down = lbutton_down();
        // Only a press that starts on a shape belongs to us. A file drag from
        // Explorer already has the button down, so it must not pin the window.
        if down && !was_down && sample.hit {
            press_ours = true;
        }
        if !down {
            press_ours = false;
        }
        was_down = down;

        let mut hold = sample.hold;
        if hold && !down {
            button_up_ticks = button_up_ticks.saturating_add(1);
            if button_up_ticks >= 2 {
                set_hold(false);
                hold = false;
                button_up_ticks = 0;
            }
        } else {
            button_up_ticks = 0;
        }

        // A snap glide owns the window until it settles. Keep clicks passing
        // through instead of treating the moving sphere as a hit target.
        let want = !SUSPENDED.load(Ordering::Relaxed) && (sample.hit || hold || press_ours);
        if want == captured {
            continue;
        }
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

struct PointerSample {
    hit: bool,
    hold: bool,
}

fn sample_at(x: i32, y: i32) -> PointerSample {
    let state = lock();
    let hit = state.boxes.iter().any(|shape| contains(shape, x, y));
    PointerSample {
        hit,
        hold: state.hold,
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
