use std::env;
use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing manifest dir"));
    let index_path = manifest_dir.join("web-dist/index.html");
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_owned());

    println!("cargo:rerun-if-changed={}", index_path.display());
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("web-dist/assets").display()
    );

    if index_path.exists() {
        return;
    }

    if profile == "release" {
        panic!(
            "missing embedded web bundle at {}. Run `make release` or `make release-x86` before direct cargo release builds.",
            index_path.display()
        );
    }

    println!(
        "cargo:warning=embedded web bundle not found at {}. Development builds can ignore this, but release builds should go through `make release` or `make release-x86`.",
        index_path.display()
    );
}
