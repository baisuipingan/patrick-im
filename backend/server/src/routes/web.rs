use include_dir::{Dir, File, include_dir};
use salvo::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use salvo::prelude::*;
use std::path::{Component, Path, PathBuf};

static WEB_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/web-dist");
const INDEX_FILE: &str = "index.html";

#[handler]
pub async fn index(res: &mut Response) -> Result<(), StatusError> {
    serve_index(res)
}

#[handler]
pub async fn asset(req: &mut Request, res: &mut Response) -> Result<(), StatusError> {
    let requested = req.param::<String>("path").unwrap_or_default();
    let relative = sanitize_relative_path(&requested)
        .ok_or_else(|| StatusError::bad_request().brief("invalid asset path"))?;

    if relative.as_os_str().is_empty() {
        return serve_index(res);
    }

    let normalized = normalize_asset_key(&relative);
    if let Some(file) = WEB_DIST.get_file(&normalized) {
        return serve_file(file, immutable_cache(&relative), res);
    }

    if looks_like_asset_path(&relative) {
        return Err(StatusError::not_found().brief("file not found"));
    }

    serve_index(res)
}

fn sanitize_relative_path(input: &str) -> Option<PathBuf> {
    let mut path = PathBuf::new();
    for component in Path::new(input).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(segment) => path.push(segment),
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    Some(path)
}

fn normalize_asset_key(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(segment) => Some(segment.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn immutable_cache(path: &Path) -> bool {
    path.components()
        .next()
        .and_then(|component| match component {
            Component::Normal(segment) => Some(segment == "assets"),
            _ => None,
        })
        .unwrap_or(false)
}

fn looks_like_asset_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|file_name| Path::new(file_name).extension())
        .is_some()
}

fn serve_index(res: &mut Response) -> Result<(), StatusError> {
    let index_file = WEB_DIST
        .get_file(INDEX_FILE)
        .ok_or_else(|| StatusError::service_unavailable().brief("web bundle is not embedded"))?;
    serve_file(index_file, false, res)
}

fn serve_file(
    file: &File<'_>,
    immutable_cache: bool,
    res: &mut Response,
) -> Result<(), StatusError> {
    let content_type = mime_guess::from_path(file.path()).first_or_octet_stream();

    res.status_code = Some(StatusCode::OK);
    res.headers_mut().insert(
        CONTENT_TYPE,
        salvo::http::HeaderValue::from_str(content_type.as_ref())
            .map_err(|_| StatusError::internal_server_error())?,
    );
    res.headers_mut().insert(
        CACHE_CONTROL,
        if immutable_cache {
            salvo::http::HeaderValue::from_static("public, max-age=31536000, immutable")
        } else {
            salvo::http::HeaderValue::from_static("no-cache")
        },
    );
    res.write_body(file.contents().to_vec())
        .map_err(|_| StatusError::internal_server_error())?;
    Ok(())
}
