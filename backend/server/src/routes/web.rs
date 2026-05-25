use crate::http::{ApiError, ApiResult};
use axum::body::Body;
use axum::extract::Path as AxumPath;
use axum::http::HeaderMap;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::response::Response;
use include_dir::{Dir, File, include_dir};
use std::path::{Component, Path, PathBuf};

static WEB_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/web-dist");
const INDEX_FILE: &str = "index.html";

pub async fn index() -> ApiResult<Response> {
    serve_index()
}

pub async fn asset(AxumPath(requested): AxumPath<String>) -> ApiResult<Response> {
    let relative = sanitize_relative_path(&requested)
        .ok_or_else(|| ApiError::bad_request("invalid asset path"))?;

    if relative.as_os_str().is_empty() {
        return serve_index();
    }

    let normalized = normalize_asset_key(&relative);
    if let Some(file) = WEB_DIST.get_file(&normalized) {
        return serve_file(file, immutable_cache(&relative));
    }

    if looks_like_asset_path(&relative) {
        return Err(ApiError::not_found("file not found"));
    }

    serve_index()
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

fn serve_index() -> ApiResult<Response> {
    let index_file = WEB_DIST
        .get_file(INDEX_FILE)
        .ok_or_else(|| ApiError::service_unavailable("web bundle is not embedded"))?;
    serve_file(index_file, false)
}

fn serve_file(file: &File<'_>, immutable_cache: bool) -> ApiResult<Response> {
    let content_type = mime_guess::from_path(file.path()).first_or_octet_stream();
    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        content_type
            .as_ref()
            .parse()
            .map_err(|_| ApiError::internal("invalid content-type header"))?,
    );
    headers.insert(
        CACHE_CONTROL,
        if immutable_cache {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }
        .parse()
        .map_err(|_| ApiError::internal("invalid cache-control header"))?,
    );

    let mut response = Response::builder()
        .body(Body::from(file.contents().to_vec()))
        .map_err(ApiError::from_internal)?;
    *response.headers_mut() = headers;
    Ok(response)
}
