use std::path::{Path, PathBuf};

use crate::error::{GazeError, GazeResult};

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::runtime::ProtocolObject;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypeString, NSWorkspace,
    };
    use objc2_foundation::{NSArray, NSFileManager, NSString, NSURL};

    fn require_main_thread() -> GazeResult<()> {
        MainThreadMarker::new()
            .map(|_| ())
            .ok_or_else(|| GazeError::Message("系统剪贴板和访达操作必须在主线程执行。".into()))
    }

    fn file_url(path: &Path) -> GazeResult<objc2::rc::Retained<NSURL>> {
        let path = path
            .to_str()
            .ok_or_else(|| GazeError::InvalidPath("文件路径不是有效的 Unicode。".into()))?;
        Ok(NSURL::fileURLWithPath(&NSString::from_str(path)))
    }

    fn read_paths(board: &NSPasteboard) -> GazeResult<Vec<PathBuf>> {
        let mut paths = Vec::new();
        if let Some(items) = board.pasteboardItems() {
            for item in items {
                // File URLs are distinct from path text and ordinary web URLs.
                if let Some(value) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) {
                    let url = NSURL::URLWithString(&value)
                        .ok_or_else(|| GazeError::InvalidPath("剪贴板文件 URL 无效。".into()))?;
                    if !url.isFileURL()
                        || url
                            .host()
                            .is_some_and(|host| !host.is_empty() && host.to_string() != "localhost")
                    {
                        return Err(GazeError::InvalidPath("只支持本地文件 URL。".into()));
                    }
                    let path = url
                        .path()
                        .ok_or_else(|| GazeError::InvalidPath("剪贴板文件路径无效。".into()))?;
                    let path = PathBuf::from(path.to_string());
                    if !path.is_absolute() {
                        return Err(GazeError::InvalidPath(
                            "剪贴板文件路径必须为绝对路径。".into(),
                        ));
                    }
                    if !paths.contains(&path) {
                        paths.push(path);
                    }
                }
            }
        }
        Ok(paths)
    }

    fn write_paths(board: &NSPasteboard, paths: &[PathBuf]) -> GazeResult<()> {
        let urls = paths
            .iter()
            .map(|path| file_url(path))
            .collect::<GazeResult<Vec<_>>>()?;
        let objects: Vec<_> = urls
            .iter()
            .map(|url| ProtocolObject::from_ref(&**url))
            .collect();
        board.clearContents();
        if !board.writeObjects(&NSArray::from_slice(&objects)) {
            return Err(GazeError::Message("无法复制文件到系统剪贴板。".into()));
        }
        Ok(())
    }

    fn write_path(board: &NSPasteboard, path: &Path) -> GazeResult<()> {
        let value = path
            .to_str()
            .ok_or_else(|| GazeError::InvalidPath("文件路径不是有效的 Unicode。".into()))?;
        board.clearContents();
        if !board.setString_forType(&NSString::from_str(value), unsafe {
            NSPasteboardTypeString
        }) {
            return Err(GazeError::Message("无法复制路径到系统剪贴板。".into()));
        }
        Ok(())
    }

    pub fn clipboard_paths() -> GazeResult<Vec<PathBuf>> {
        require_main_thread()?;
        read_paths(&NSPasteboard::generalPasteboard())
    }

    pub fn copy_file(path: &Path) -> GazeResult<()> {
        require_main_thread()?;
        write_paths(&NSPasteboard::generalPasteboard(), &[path.to_path_buf()])
    }

    pub fn copy_path(path: &Path) -> GazeResult<()> {
        require_main_thread()?;
        write_path(&NSPasteboard::generalPasteboard(), path)
    }

    pub fn reveal(path: &Path) -> GazeResult<()> {
        require_main_thread()?;
        let url = file_url(path)?;
        NSWorkspace::sharedWorkspace()
            .activateFileViewerSelectingURLs(&NSArray::from_slice(&[&*url]));
        Ok(())
    }

    pub fn copy_item(source: &Path, target: &Path) -> GazeResult<()> {
        let source = file_url(source)?;
        let target = file_url(target)?;
        NSFileManager::defaultManager()
            .copyItemAtURL_toURL_error(&source, &target)
            .map_err(|error| GazeError::Message(format!("无法复制文件：{error}")))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn shared_appkit_operations_reject_background_threads_before_accessing_the_pasteboard() {
            std::thread::spawn(|| {
                let path = Path::new("/tmp/unused");
                for result in [
                    clipboard_paths().map(|_| ()),
                    copy_file(path),
                    copy_path(path),
                    reveal(path),
                ] {
                    assert!(result.unwrap_err().to_string().contains("必须在主线程"));
                }
            })
            .join()
            .unwrap();
        }

        #[test]
        fn isolated_clipboard_round_trips_files_and_path_text() {
            let board = NSPasteboard::pasteboardWithUniqueName();
            let paths = vec![
                PathBuf::from("/tmp/中文 空格/#a.txt"),
                PathBuf::from("/tmp/b"),
            ];
            write_paths(&board, &paths).unwrap();
            assert_eq!(read_paths(&board).unwrap(), paths);
            write_path(&board, &paths[0]).unwrap();
            assert!(read_paths(&board).unwrap().is_empty());
            assert_eq!(
                board
                    .stringForType(unsafe { NSPasteboardTypeString })
                    .unwrap()
                    .to_string(),
                paths[0].to_str().unwrap()
            );
            board.clearContents();
        }

        #[test]
        fn finder_url_preserves_the_selected_path() {
            let path = Path::new("/tmp/中文 # file.txt");
            assert_eq!(
                file_url(path).unwrap().path().unwrap().to_string(),
                path.to_str().unwrap()
            );
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
pub fn clipboard_paths() -> GazeResult<Vec<PathBuf>> {
    Err(GazeError::Unsupported(
        "系统文件操作目前仅支持 macOS。".into(),
    ))
}

#[cfg(not(target_os = "macos"))]
pub fn copy_file(_path: &Path) -> GazeResult<()> {
    clipboard_paths().map(|_| ())
}

#[cfg(not(target_os = "macos"))]
pub use copy_file as copy_path;
#[cfg(not(target_os = "macos"))]
pub use copy_file as reveal;

#[cfg(not(target_os = "macos"))]
pub fn copy_item(_source: &Path, _target: &Path) -> GazeResult<()> {
    clipboard_paths().map(|_| ())
}
