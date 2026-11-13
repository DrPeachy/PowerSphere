//! Windows file drop and click-through for the sphere window.
//!
//! `HTTRANSPARENT` only continues the hit test inside this thread, so the
//! pre-sized window still takes clicks meant for other programs. The window
//! region is the shape other programs can click through. It is rebuilt from
//! the current circles on every collapse and expand. File drags over the main
//! sphere still hit this window's `IDropTarget`.

#![allow(unsafe_code)]

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter};
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, POINTL, WPARAM},
        Graphics::Gdi::{
            CombineRgn, CreateEllipticRgn, CreateRectRgn, DeleteObject, RGN_OR, ScreenToClient,
            SetWindowRgn,
        },
        System::{
            Com::{DVASPECT_CONTENT, FORMATETC, IDataObject, TYMED_HGLOBAL},
            Ole::{
                CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE, IDropTarget,
                IDropTarget_Impl, RegisterDragDrop, RevokeDragDrop,
            },
            SystemServices::MODIFIERKEYS_FLAGS,
        },
        UI::{
            Input::KeyboardAndMouse::{TME_LEAVE, TRACKMOUSEEVENT, TrackMouseEvent},
            Shell::{
                DefSubclassProc, DragAcceptFiles, DragFinish, DragQueryFileW, HDROP,
                SetWindowSubclass,
            },
            WindowsAndMessaging::{
                EnumChildWindows, HTCLIENT, HTTRANSPARENT, PostMessageW, WM_APP, WM_NCHITTEST,
            },
        },
    },
    core::implement,
};

/// Posted to ourselves so the webview is notified outside `WM_NCHITTEST`.
const HOVER_MSG: u32 = WM_APP + 73;
const WM_MOUSELEAVE: u32 = 0x02A3;

#[derive(Clone)]
struct HitBox {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    round: bool,
}

struct HitState {
    generation: u64,
    boxes: Vec<HitBox>,
}

static HIT_BOXES: Mutex<HitState> = Mutex::new(HitState {
    generation: 0,
    boxes: Vec::new(),
});
static INSTALLED: Mutex<bool> = Mutex::new(false);
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);
static HOVER_INSIDE: AtomicBool = AtomicBool::new(false);
static LEAVE_ARMED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
struct FileDragEvent {
    kind: &'static str,
    paths: Vec<String>,
    x: f64,
    y: f64,
}

pub fn update_hit_boxes(rects: &[(f64, f64, f64, f64, bool)], scale: f64, generation: u64) -> bool {
    let mut boxes = Vec::new();
    for (x, y, w, h, round) in rects {
        if !(w.is_finite() && h.is_finite() && *w > 0.0 && *h > 0.0) {
            continue;
        }
        boxes.push(HitBox {
            left: (x * scale).round() as i32,
            top: (y * scale).round() as i32,
            right: ((x + w) * scale).round() as i32,
            bottom: ((y + h) * scale).round() as i32,
            round: *round,
        });
    }
    let mut guard = HIT_BOXES.lock().unwrap_or_else(|err| err.into_inner());
    if generation < guard.generation {
        return false;
    }
    guard.generation = generation;
    guard.boxes = boxes;
    true
}

pub fn point_hits(x: i32, y: i32) -> bool {
    let Ok(guard) = HIT_BOXES.lock() else {
        return false;
    };
    guard.boxes.iter().any(|rect| contains(rect, x, y))
}

pub fn apply_shape(hwnd: HWND) {
    let boxes = HIT_BOXES
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .boxes
        .clone();
    unsafe {
        let mut region = None;
        for rect in &boxes {
            let part = if rect.round {
                CreateEllipticRgn(rect.left, rect.top, rect.right, rect.bottom)
            } else {
                CreateRectRgn(rect.left, rect.top, rect.right, rect.bottom)
            };
            if part.is_invalid() {
                continue;
            }
            region = Some(match region {
                None => part,
                Some(previous) => {
                    let _ = CombineRgn(Some(previous), Some(previous), Some(part), RGN_OR);
                    let _ = DeleteObject(part.into());
                    previous
                }
            });
        }
        let Some(region) = region else {
            let empty = CreateRectRgn(0, 0, 0, 0);
            if !empty.is_invalid() && SetWindowRgn(hwnd, Some(empty), false) == 0 {
                let _ = DeleteObject(empty.into());
            }
            return;
        };
        if SetWindowRgn(hwnd, Some(region), false) == 0 {
            let _ = DeleteObject(region.into());
        }
    }
}

fn contains(rect: &HitBox, x: i32, y: i32) -> bool {
    if rect.round {
        let rx = (rect.right - rect.left) / 2;
        let ry = (rect.bottom - rect.top) / 2;
        if rx <= 0 || ry <= 0 {
            return false;
        }
        let dx = (x - (rect.left + rect.right) / 2) as f64 / rx as f64;
        let dy = (y - (rect.top + rect.bottom) / 2) as f64 / ry as f64;
        dx * dx + dy * dy <= 1.0
    } else {
        x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
    }
}

pub fn install(hwnd: HWND, app: AppHandle) {
    if let Ok(mut guard) = APP.lock() {
        *guard = Some(app.clone());
    }
    let mut installed = INSTALLED.lock().unwrap_or_else(|err| err.into_inner());
    if *installed {
        return;
    }
    unsafe {
        let _ = SetWindowSubclass(hwnd, Some(hit_test_proc), 1, 0);
        register_drop_target(hwnd, &app);
        let mut callback = |child| {
            register_drop_target(child, &app);
            true
        };
        let mut trait_obj: &mut dyn FnMut(HWND) -> bool = &mut callback;
        let pointer: *mut std::ffi::c_void = std::mem::transmute(&mut trait_obj);
        unsafe extern "system" fn each(child: HWND, param: LPARAM) -> windows::core::BOOL {
            unsafe {
                let closure =
                    &mut *(param.0 as *mut std::ffi::c_void as *mut &mut dyn FnMut(HWND) -> bool);
                closure(child).into()
            }
        }
        let _ = EnumChildWindows(Some(hwnd), Some(each), LPARAM(pointer as _));
        DragAcceptFiles(hwnd, true);
        *installed = true;
    }
}

fn sync_hover(hwnd: HWND, inside: bool) {
    let was = HOVER_INSIDE.swap(inside, Ordering::Relaxed);
    if inside {
        arm_leave(hwnd);
    }
    if was == inside {
        return;
    }
    unsafe {
        let _ = PostMessageW(
            Some(hwnd),
            HOVER_MSG,
            WPARAM(if inside { 1 } else { 0 }),
            LPARAM(0),
        );
    }
}

fn arm_leave(hwnd: HWND) {
    if LEAVE_ARMED.load(Ordering::Relaxed) {
        return;
    }
    let mut event = TRACKMOUSEEVENT {
        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
        dwFlags: TME_LEAVE,
        hwndTrack: hwnd,
        dwHoverTime: 0,
    };
    let armed = unsafe { TrackMouseEvent(&mut event).is_ok() };
    if armed {
        LEAVE_ARMED.store(true, Ordering::Relaxed);
    }
}

fn emit_hover(inside: bool) {
    let app = APP.lock().ok().and_then(|guard| guard.clone());
    let Some(app) = app else {
        return;
    };
    let _ = app.emit("powersphere://hover", HoverEvent { inside });
}

#[derive(Clone, serde::Serialize)]
struct HoverEvent {
    inside: bool,
}

fn register_drop_target(hwnd: HWND, app: &AppHandle) {
    let target: IDropTarget = FileDrop::new(app.clone(), hwnd).into();
    unsafe {
        let _ = RevokeDragDrop(hwnd);
        if RegisterDragDrop(hwnd, &target).is_ok() {
            // Keep the COM object alive for the process.
            std::mem::forget(target);
        }
    }
}

unsafe extern "system" fn hit_test_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    unsafe {
        if msg == HOVER_MSG {
            emit_hover(wparam.0 != 0);
            return LRESULT(0);
        }
        if msg == WM_MOUSELEAVE {
            // Tracking is one-shot. The cursor left the window rectangle
            // without another hit-test, for example off the screen edge.
            LEAVE_ARMED.store(false, Ordering::Relaxed);
            sync_hover(hwnd, false);
            return DefSubclassProc(hwnd, msg, wparam, lparam);
        }
        if msg == WM_NCHITTEST {
            let packed = lparam.0 as u32;
            let mut point = POINT {
                x: (packed & 0xffff) as i16 as i32,
                y: (packed >> 16) as i16 as i32,
            };
            let _ = ScreenToClient(hwnd, &mut point);
            let inside = point_hits(point.x, point.y);
            sync_hover(hwnd, inside);
            if inside {
                return LRESULT(HTCLIENT as _);
            }
            return LRESULT(HTTRANSPARENT as _);
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}

#[implement(IDropTarget)]
struct FileDrop {
    app: AppHandle,
    hwnd: HWND,
}

impl FileDrop {
    fn new(app: AppHandle, hwnd: HWND) -> Self {
        Self { app, hwnd }
    }

    fn client_point(&self, pt: &POINTL) -> (f64, f64) {
        let mut point = POINT { x: pt.x, y: pt.y };
        unsafe {
            let _ = ScreenToClient(self.hwnd, &mut point);
        }
        (point.x as f64, point.y as f64)
    }

    fn emit(&self, kind: &'static str, paths: Vec<String>, x: f64, y: f64) {
        let _ = self.app.emit(
            "powersphere://file-drag",
            FileDragEvent { kind, paths, x, y },
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
        let accepted = !paths.is_empty();
        unsafe {
            *effect = if accepted {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            };
        }
        if accepted {
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
            *effect = DROPEFFECT_COPY;
        }
        let (x, y) = self.client_point(pt);
        self.emit("over", Vec::new(), x, y);
        Ok(())
    }

    fn DragLeave(&self) -> windows_core::Result<()> {
        self.emit("leave", Vec::new(), 0.0, 0.0);
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
            *effect = if paths.is_empty() {
                DROPEFFECT_NONE
            } else {
                DROPEFFECT_COPY
            };
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
