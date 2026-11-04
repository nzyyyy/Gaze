use std::fs::File;
use std::io::Read;
use std::path::Path;

use percent_encoding::percent_decode_str;
use serde::Serialize;

use crate::error::{GazeError, GazeResult};
use crate::files::{path_to_relative, resolve_within_root, MAX_FILE_BYTES};
use crate::models::Project;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownLink {
    pub path: String,
    pub fragment: Option<String>,
}

#[derive(Debug)]
pub struct ImageRequest {
    pub project_id: String,
    pub document_path: String,
    pub src: String,
}

#[derive(Debug)]
pub struct ImageData {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

pub fn parse_image_request(uri: &str) -> GazeResult<ImageRequest> {
    let url =
        url::Url::parse(uri).map_err(|_| GazeError::InvalidPath("图片资源请求无效。".into()))?;
    if url.path() != "/" {
        return Err(GazeError::InvalidPath("图片资源请求无效。".into()));
    }
    let mut project_id = None;
    let mut document_path = None;
    let mut src = None;
    for (key, value) in url.query_pairs() {
        let slot = match key.as_ref() {
            "projectId" => &mut project_id,
            "documentPath" => &mut document_path,
            "src" => &mut src,
            _ => return Err(GazeError::InvalidPath("图片资源请求无效。".into())),
        };
        if slot.replace(value.into_owned()).is_some() {
            return Err(GazeError::InvalidPath("图片资源请求无效。".into()));
        }
    }
    Ok(ImageRequest {
        project_id: project_id
            .filter(|value| !value.is_empty())
            .ok_or_else(|| GazeError::InvalidPath("图片资源请求无效。".into()))?,
        document_path: document_path
            .filter(|value| !value.is_empty())
            .ok_or_else(|| GazeError::InvalidPath("图片资源请求无效。".into()))?,
        src: src
            .filter(|value| !value.is_empty())
            .ok_or_else(|| GazeError::InvalidPath("图片资源请求无效。".into()))?,
    })
}

fn decode(value: &str) -> GazeResult<String> {
    percent_decode_str(value)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|_| GazeError::InvalidPath("链接不是有效的 UTF-8。".into()))
}

pub fn resolve_link(
    project: &Project,
    document_path: &str,
    href: &str,
) -> GazeResult<MarkdownLink> {
    let root = Path::new(&project.root);
    let document = resolve_within_root(root, document_path)?;
    if !document.is_file() {
        return Err(GazeError::InvalidPath("Markdown 来源不是文件。".into()));
    }
    let (target, fragment) = match href.split_once('#') {
        Some((target, fragment)) => (target, Some(decode(fragment)?)),
        None => (href, None),
    };
    let target = decode(target.split('?').next().unwrap_or_default())?;
    if target.contains(['\\', '\0']) || target.starts_with("//") || url::Url::parse(&target).is_ok()
    {
        return Err(GazeError::InvalidPath("只接受项目内的文件链接。".into()));
    }
    let base = if target.is_empty() {
        document_path
    } else if target.starts_with('/') {
        ""
    } else {
        document_path
            .rsplit_once('/')
            .map_or("", |(parent, _)| parent)
    };
    let mut parts: Vec<&str> = base.split('/').filter(|part| !part.is_empty()).collect();
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(GazeError::InvalidPath("链接指向项目目录之外。".into()));
                }
            }
            part => parts.push(part),
        }
    }
    let resolved = resolve_within_root(root, &parts.join("/"))?;
    if !resolved.is_file() {
        return Err(GazeError::InvalidPath("链接目标不是文件。".into()));
    }
    Ok(MarkdownLink {
        path: path_to_relative(root, &resolved)?,
        fragment,
    })
}

pub fn read_image(project: &Project, document_path: &str, src: &str) -> GazeResult<ImageData> {
    let link = resolve_link(project, document_path, src)?;
    let path = resolve_within_root(Path::new(&project.root), &link.path)?;
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return Err(GazeError::Unsupported("不支持的图片类型。".into())),
    };
    let file = File::open(path)?;
    if file.metadata()?.len() > MAX_FILE_BYTES {
        return Err(GazeError::TooLarge("图片超过 20 MiB 读取上限。".into()));
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(GazeError::TooLarge("图片超过 20 MiB 读取上限。".into()));
    }
    Ok(ImageData { mime, bytes })
}

pub fn external_url(value: &str) -> GazeResult<url::Url> {
    let url =
        url::Url::parse(value).map_err(|_| GazeError::InvalidPath("网页链接无效。".into()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(GazeError::InvalidPath(
            "只允许打开 HTTP 或 HTTPS 网页。".into(),
        ));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> (tempfile::TempDir, Project) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("docs/README.md"), "# Guide").unwrap();
        fs::write(root.join("root.md"), "# Root").unwrap();
        fs::write(root.join("docs/中文 + name.md"), "# 章节").unwrap();
        let project = Project {
            id: "p".into(),
            name: "test".into(),
            root: root.to_string_lossy().into(),
        };
        (directory, project)
    }

    #[test]
    fn parses_encoded_image_protocol_requests() {
        let request = parse_image_request(
            "gaze-image://localhost/?projectId=p%201&documentPath=docs%2FREADME.md&src=..%2Fimages%2F%E4%B8%AD%E6%96%87+%2B+name.png%3Fraw%3D1%23preview",
        )
        .unwrap();
        assert_eq!(request.project_id, "p 1");
        assert_eq!(request.document_path, "docs/README.md");
        assert_eq!(request.src, "../images/中文 + name.png?raw=1#preview");
        for uri in [
            "gaze-image://localhost/",
            "gaze-image://localhost/other?projectId=p&documentPath=docs%2FREADME.md&src=a.png",
            "gaze-image://localhost/?projectId=p&projectId=q&documentPath=docs%2FREADME.md&src=a.png",
            "gaze-image://localhost/?projectId=p&documentPath=docs%2FREADME.md&src=a.png&unexpected=1",
        ] {
            assert!(parse_image_request(uri).is_err(), "{uri}");
        }
    }

    #[test]
    fn resolves_markdown_relative_root_and_encoded_links() {
        let (_directory, project) = fixture();
        for href in ["../root.md", "/root.md", "./../root.md?raw=1"] {
            assert_eq!(
                resolve_link(&project, "docs/README.md", href).unwrap().path,
                "root.md"
            );
        }
        let result = resolve_link(
            &project,
            "docs/README.md",
            "%E4%B8%AD%E6%96%87%20+%20name.md#%E7%AB%A0%E8%8A%82",
        )
        .unwrap();
        assert_eq!(result.path, "docs/中文 + name.md");
        assert_eq!(result.fragment.as_deref(), Some("章节"));
        let same = resolve_link(&project, "docs/README.md", "#guide").unwrap();
        assert_eq!(same.path, "docs/README.md");
        assert_eq!(same.fragment.as_deref(), Some("guide"));
    }

    #[test]
    fn rejects_escaping_paths_protocols_directories_and_missing_files() {
        let (_directory, project) = fixture();
        for href in [
            "../../root.md",
            "../%2e%2e/root.md",
            "//example.com/a.png",
            "%2f%2fexample.com/a",
            "file:///etc/passwd",
            "https://example.com",
            "javascript:alert(1)",
            "..\\root.md",
            "x%00.png",
            "%FF.md",
            "/docs",
            "missing.md",
        ] {
            assert!(
                resolve_link(&project, "docs/README.md", href).is_err(),
                "{href}"
            );
        }
        assert!(resolve_link(&project, "../README.md", "root.md").is_err());
        assert!(resolve_link(&project, "docs", "root.md").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_outside_the_project() {
        let (_directory, project) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("private.png"), b"private").unwrap();
        std::os::unix::fs::symlink(outside.path(), Path::new(&project.root).join("outside"))
            .unwrap();
        assert!(resolve_link(&project, "docs/README.md", "../outside/private.png").is_err());
        assert!(read_image(&project, "docs/README.md", "../outside/private.png").is_err());
        std::os::unix::fs::symlink(
            Path::new(&project.root).join("root.md"),
            Path::new(&project.root).join("alias.md"),
        )
        .unwrap();
        assert_eq!(
            resolve_link(&project, "docs/README.md", "../alias.md")
                .unwrap()
                .path,
            "root.md"
        );
    }

    #[test]
    fn reads_supported_images_as_bytes_and_mime() {
        let (_directory, project) = fixture();
        for (extension, mime) in [
            ("PNG", "image/png"),
            ("jpg", "image/jpeg"),
            ("jpeg", "image/jpeg"),
            ("gif", "image/gif"),
            ("webp", "image/webp"),
            ("svg", "image/svg+xml"),
        ] {
            fs::write(
                Path::new(&project.root).join(format!("image.{extension}")),
                b"image",
            )
            .unwrap();
            let image =
                read_image(&project, "docs/README.md", &format!("../image.{extension}")).unwrap();
            assert_eq!(image.mime, mime);
            assert_eq!(image.bytes, b"image");
        }
        assert!(matches!(
            read_image(&project, "docs/README.md", "../root.md"),
            Err(GazeError::Unsupported(_))
        ));
    }

    #[test]
    fn refuses_oversized_images() {
        let (_directory, project) = fixture();
        let file = File::create(Path::new(&project.root).join("big.png")).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(matches!(
            read_image(&project, "docs/README.md", "/big.png"),
            Err(GazeError::TooLarge(_))
        ));
    }

    #[test]
    fn external_browser_only_accepts_web_urls() {
        for url in [
            "https://example.com/a?q=1#b",
            "http://localhost:8080",
            "HTTPS://EXAMPLE.COM",
        ] {
            assert!(external_url(url).is_ok());
        }
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,test",
            "mailto:a@example.com",
            "ftp://example.com",
            "../file",
            "https://",
        ] {
            assert!(external_url(url).is_err(), "{url}");
        }
    }
}
