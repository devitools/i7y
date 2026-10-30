fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/platform.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("i7y_platform");
        for framework in [
            "Foundation",
            "LocalAuthentication",
            "AppKit",
            "Security",
            "ApplicationServices",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,LocalAuthenticationEmbeddedUI");
        println!("cargo:rerun-if-changed=src/platform.m");
    }
    tauri_build::build();
}
