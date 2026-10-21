use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn project_dir() -> String { trios_config::project_dir() }

/// Keep only the `keep` most recent clade-build*.log files so the log
/// directory does not fill with transient build artifacts.
fn rotate_clade_build_logs(log_dir: &str, keep: usize) {
    let prefix = "clade-build";
    let suffix = ".log";
    let max_age = std::time::Duration::from_secs(7 * 24 * 60 * 60);
    let now = std::time::SystemTime::now();
    let mut entries = vec![];
    let Ok(files) = fs::read_dir(log_dir) else { return };
    for entry in files.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(prefix) && name.ends_with(suffix) {
            if let Ok(meta) = entry.metadata() {
                let mut keep_file = true;
                if let Ok(modified) = meta.modified() {
                    if now.duration_since(modified).unwrap_or_default() > max_age {
                        let _ = fs::remove_file(entry.path());
                        keep_file = false;
                    }
                }
                if keep_file {
                    entries.push((meta.modified().unwrap_or(now), entry.path()));
                }
            }
        }
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in entries.iter().skip(keep) {
        let _ = fs::remove_file(path);
    }
}

struct Variant {
    name: &'static str,
    output: PathBuf,
    app_bundle: PathBuf,
    bundle_id: &'static str,
    mcp_port: &'static str,
    a2a_port: &'static str,
    mesh_port: &'static str,
    canary_mcp_port: &'static str,
    build_root: PathBuf,
}

fn main() {
    let variant_name = env::var("TRIOS_VARIANT").unwrap_or_else(|_| "prod".into());
    let variant = resolve_variant(&variant_name);

    println!(
        "[CladeBuild] Variant={}, output={}",
        variant.name,
        variant.output.display()
    );

    // Collect Swift files — match build.sh: all rings, only the lean BR-OUTPUT
    // whitelist so untracked prototypes cannot break the app build.
    let mut swift_files = vec![variant.build_root.join("main.swift")];
    collect_swift_files(&variant.build_root.join("rings"), &mut swift_files);
    collect_lean_br_output(&variant.build_root.join("BR-OUTPUT"), &mut swift_files);

    // Build Trinity QueenUILib dependency first so the trios sources can import it.
    let queen_bin_dir = match build_queen_lib() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[FAIL] {}", e);
            std::process::exit(1);
        }
    };
    let queen_modules_dir = format!("{}/Modules", queen_bin_dir);

    // SQLCipher is required for the encrypted agent-memory store. Discover the
    // Homebrew-installed library and CSQLCipher module map (sibling to trios).
    let sqlcipher = match resolve_sqlcipher(&variant.build_root) {
        Ok(s) => s,
        Err(e) => { eprintln!("[FAIL] {}", e); std::process::exit(1); }
    };

    // TRI-NET calling seam (.trinity/specs/internet-calls.md, #2053): the
    // pinned TRI-NET shared Swift plus a SwiftPM-built LiveKit.
    let seam = match build_calling_seam(&variant.build_root) {
        Ok(s) => s,
        Err(e) => { eprintln!("[FAIL] {}", e); std::process::exit(1); }
    };
    swift_files.extend(seam.swift_files.iter().cloned());
    let file_count = swift_files.len();

    // Build
    let mut cmd = Command::new("swiftc");
    cmd.arg("-O")
        .arg("-o")
        .arg(&variant.output)
        .arg("-framework")
        .arg("SwiftUI")
        .arg("-framework")
        .arg("AppKit")
        .arg("-framework")
        .arg("WebKit")
        .arg("-framework")
        .arg("Combine")
        .arg("-framework")
        .arg("Security")
        .arg("-I")
        .arg(&sqlcipher.csqlcipher_modulemap_dir)
        .arg("-I")
        .arg(&sqlcipher.include_dir)
        .arg("-L")
        .arg(&sqlcipher.lib_dir)
        .arg("-lsqlcipher")
        .arg("-I")
        .arg(&queen_modules_dir)
        .arg("-L")
        .arg(&queen_bin_dir)
        .arg("-lQueenUILib")
        .arg("-D")
        .arg("TRIOS_CALLS")
        .arg("-I")
        .arg(seam.bin_dir.join("Modules"))
        // Not the whole build directory: its *.build/module.modulemap files
        // define SwiftProtobuf twice (library and -tool) and clang refuses.
        .arg("-F")
        .arg(&seam.bin_dir)
        .arg("-L")
        .arg(&seam.bin_dir)
        .arg("-lTriOSLiveKit")
        .arg("-Xlinker")
        .arg("-rpath")
        .arg("-Xlinker")
        .arg("@executable_path/Frameworks")
        .arg("-Xlinker")
        .arg("-rpath")
        .arg("-Xlinker")
        .arg("@executable_path/../Frameworks");

    for f in &swift_files {
        cmd.arg(f);
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => { eprintln!("[FAIL] swiftc failed to start: {}", e); std::process::exit(1); }
    };
    let log_path = format!("{}/.trinity/logs/clade-build_{}.log", project_dir(), variant.name);
    rotate_clade_build_logs(&format!("{}/.trinity/logs", project_dir()), 10);
    if let Err(e) = fs::write(&log_path, &output.stderr) {
        eprintln!("[build] Failed to write build log {}: {}", log_path, e);
    }

    if !output.status.success() {
        eprintln!("[FAIL] Build failed for variant={}", variant.name);
        eprintln!("{}", String::from_utf8_lossy(&output.stderr));
        std::process::exit(1);
    }

    println!("[OK] Build successful: {}", variant.output.display());
    if let Err(e) = fs::set_permissions(&variant.output, std::fs::Permissions::from_mode(0o755)) {
        eprintln!("[CladeBuild] Failed to set binary permissions: {}", e);
    }

    // Ensure .app bundle structure
    let macos = variant.app_bundle.join("Contents/MacOS");
    let resources = variant.app_bundle.join("Contents/Resources");
    if let Err(e) = fs::create_dir_all(&macos) {
        eprintln!("[CladeBuild] Failed to create MacOS dir: {}", e);
    }
    if let Err(e) = fs::create_dir_all(&resources) {
        eprintln!("[CladeBuild] Failed to create Resources dir: {}", e);
    }

    // Generate Info.plist
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>trios</string>
    <key>CFBundleIdentifier</key><string>{}</string>
    <key>CFBundleName</key><string>Trios {}</string>
    <key>CFBundleVersion</key><string>1.0.0</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>TRIOS_VARIANT</key><string>{}</string>
    <key>TRIOS_MCP_PORT</key><string>{}</string>
    <key>TRIOS_A2A_PORT</key><string>{}</string>
    <key>TRIOS_MESH_PORT</key><string>{}</string>
    <key>TRIOS_CANARY_MCP_PORT</key><string>{}</string>
    <key>TRINET_IDENTITY_KEYCHAIN_SERVICE</key><string>com.browseros.trios.trinet-identity</string>
    <key>NSMicrophoneUsageDescription</key><string>TriOS uses the microphone for Internet calls you place or answer.</string>
</dict>
</plist>"#,
        variant.bundle_id,
        capitalize(variant.name),
        variant.name,
        variant.mcp_port,
        variant.a2a_port,
        variant.mesh_port,
        variant.canary_mcp_port
    );
    if let Err(e) = fs::write(variant.app_bundle.join("Contents/Info.plist"), plist) {
        eprintln!("[FAIL] Failed to write Info.plist: {}", e);
        std::process::exit(1);
    }

    // Bundle the SQLCipher dynamic library so the .app is runnable on its own.
    let frameworks = variant.app_bundle.join("Contents/Frameworks");
    if let Err(e) = fs::create_dir_all(&frameworks) {
        eprintln!("[CladeBuild] Failed to create Frameworks dir: {}", e);
    }
    let bundled_dylib = frameworks.join(&sqlcipher.dylib_name);
    if let Err(e) = bundle_sqlcipher_dylib(&sqlcipher.dylib_source, &bundled_dylib, &variant.output
    ) {
        eprintln!("[CladeBuild] Failed to bundle SQLCipher dylib: {}", e);
    }
    if let Err(e) = embed_calling_seam(&seam, &frameworks) {
        eprintln!("[FAIL] {}", e);
        std::process::exit(1);
    }
    // A runnable bundle (#2053): CFBundleExecutable=trios must exist in
    // Contents/MacOS, QueenUILib must be next to the other frameworks, and
    // the bundle is signed ad hoc after its last change.
    if let Err(e) = complete_app_bundle(&variant, &queen_bin_dir, &macos, &frameworks) {
        eprintln!("[FAIL] {}", e);
        std::process::exit(1);
    }

    println!(
        "[OK] Copied to .app bundle: {} (files={}, ports MCP={} A2A={} MESH={} CANARY={})",
        variant.app_bundle.display(),
        file_count,
        variant.mcp_port,
        variant.a2a_port,
        variant.mesh_port,
        variant.canary_mcp_port
    );
}

struct SQLCipherPaths {
    include_dir: String,
    lib_dir: String,
    csqlcipher_modulemap_dir: String,
    dylib_source: PathBuf,
    dylib_name: String,
}

fn resolve_sqlcipher(build_root: &Path) -> Result<SQLCipherPaths, String> {
    let include_dir = run_pkg_config("--variable=includedir")?;
    let lib_dir = run_pkg_config("--variable=libdir")?;
    // apps/trios-macos keeps Sources/CSQLCipher inside the app root (monorepo);
    // the old browseros layout kept it next to it. Accept either.
    let mut candidates = vec![build_root.join("Sources/CSQLCipher")];
    if let Some(parent) = build_root.parent() {
        candidates.push(parent.join("Sources/CSQLCipher"));
    }
    let csqlcipher_modulemap_dir = candidates
        .into_iter()
        .find(|dir| dir.join("module.modulemap").is_file())
        .ok_or_else(|| "Cannot locate Sources/CSQLCipher in the app root or its parent".to_string())?
        .to_string_lossy()
        .to_string();
    let dylib_source = find_sqlcipher_dylib(&lib_dir)?;
    Ok(SQLCipherPaths {
        include_dir,
        lib_dir,
        csqlcipher_modulemap_dir,
        dylib_source,
        dylib_name: "libsqlcipher.dylib".to_string(),
    })
}

/// Copies the built binary and QueenUILib into the bundle, signs it ad hoc
/// and verifies the signature. The binary is copied after SQLCipher's load
/// path was rewritten, so the bundled copy carries it.
fn complete_app_bundle(
    variant: &Variant,
    queen_bin_dir: &str,
    macos_dir: &Path,
    frameworks_dir: &Path,
) -> Result<(), String> {
    let executable = macos_dir.join("trios");
    let _ = fs::remove_file(&executable);
    fs::copy(&variant.output, &executable)
        .map_err(|e| format!("copy {} to {}: {}", variant.output.display(), executable.display(), e))?;
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("chmod {}: {}", executable.display(), e))?;
    let queen_dylib = Path::new(queen_bin_dir).join("libQueenUILib.dylib");
    let queen_target = frameworks_dir.join("libQueenUILib.dylib");
    let _ = fs::remove_file(&queen_target);
    fs::copy(&queen_dylib, &queen_target)
        .map_err(|e| format!("copy {}: {}", queen_dylib.display(), e))?;
    for args in [
        vec!["--force", "--deep", "--sign", "-"],
        vec!["--verify", "--deep", "--strict"],
    ] {
        let status = Command::new("codesign")
            .args(&args)
            .arg(&variant.app_bundle)
            .status()
            .map_err(|e| format!("codesign failed to start: {}", e))?;
        if !status.success() {
            return Err(format!("codesign {:?} {} failed", args, variant.app_bundle.display()));
        }
    }
    Ok(())
}

/// TRI-NET calling seam (.trinity/specs/internet-calls.md, #2053).
struct CallingSeam {
    swift_files: Vec<PathBuf>,
    bin_dir: PathBuf,
    dylib: PathBuf,
    frameworks: Vec<PathBuf>,
}

/// Reads `TRINET_PIN`: the TRI-NET commit and the shared files to compile.
fn read_trinet_pin(build_root: &Path) -> Result<(String, Vec<String>), String> {
    let pin_path = build_root.join("TRINET_PIN");
    let text = fs::read_to_string(&pin_path)
        .map_err(|e| format!("read {}: {}", pin_path.display(), e))?;
    let mut commit = None;
    let mut files = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(value) = line.strip_prefix("commit=") {
            commit = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("files=") {
            files = value.split_whitespace().map(str::to_string).collect();
        }
    }
    let commit = commit.ok_or_else(|| "TRINET_PIN has no commit= line".to_string())?;
    if commit.len() != 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("TRINET_PIN commit is not a full SHA: {}", commit));
    }
    if files.is_empty() {
        return Err("TRINET_PIN has no files= line".to_string());
    }
    Ok((commit, files))
}

/// Verifies the TRI-NET checkout is exactly at the pin, builds the LiveKit
/// package and returns what the app compile and the bundle need.
fn build_calling_seam(build_root: &Path) -> Result<CallingSeam, String> {
    let (commit, files) = read_trinet_pin(build_root)?;
    let trinet_root = if let Ok(root) = env::var("TRINET_ROOT") {
        PathBuf::from(root)
    } else {
        build_root
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("TRI-NET"))
            .ok_or_else(|| "Cannot derive TRINET_ROOT; set it to the gHashTag/tri-net checkout".to_string())?
    };
    let head = Command::new("git")
        .arg("-C")
        .arg(&trinet_root)
        .arg("rev-parse")
        .arg("HEAD")
        .output()
        .map_err(|e| format!("git rev-parse in {} failed: {}", trinet_root.display(), e))?;
    if !head.status.success() {
        return Err(format!("TRINET_ROOT {} is not a git checkout", trinet_root.display()));
    }
    let head = String::from_utf8_lossy(&head.stdout).trim().to_string();
    if head != commit {
        return Err(format!(
            "TRINET_ROOT {} is at {}, TRINET_PIN requires {}",
            trinet_root.display(),
            head,
            commit
        ));
    }
    let mut swift_files = Vec::new();
    for file in &files {
        let path = trinet_root.join(file);
        if !path.is_file() {
            return Err(format!("pinned TRI-NET file missing: {}", path.display()));
        }
        swift_files.push(path);
    }

    let package = build_root.join("packages/TriOSLiveKit");
    println!("[CladeBuild] Building TriOSLiveKit at {}", package.display());
    let build = Command::new("swift")
        .arg("build")
        .arg("--package-path")
        .arg(&package)
        .arg("--product")
        .arg("TriOSLiveKit")
        .output()
        .map_err(|e| format!("swift build (TriOSLiveKit) failed to start: {}", e))?;
    if !build.status.success() {
        return Err(format!(
            "TriOSLiveKit build failed:\n{}",
            String::from_utf8_lossy(&build.stderr)
        ));
    }
    let bin = Command::new("swift")
        .arg("build")
        .arg("--package-path")
        .arg(&package)
        .arg("--show-bin-path")
        .output()
        .map_err(|e| format!("swift build --show-bin-path failed to start: {}", e))?;
    if !bin.status.success() {
        return Err("swift build --show-bin-path (TriOSLiveKit) failed".to_string());
    }
    let bin_dir = PathBuf::from(String::from_utf8_lossy(&bin.stdout).trim());
    let dylib = bin_dir.join("libTriOSLiveKit.dylib");
    if !dylib.is_file() {
        return Err(format!("TriOSLiveKit was not produced: {}", dylib.display()));
    }
    let mut frameworks = Vec::new();
    let entries = fs::read_dir(&bin_dir)
        .map_err(|e| format!("read {}: {}", bin_dir.display(), e))?;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "framework") {
            frameworks.push(path);
        }
    }
    frameworks.sort();
    Ok(CallingSeam {
        swift_files,
        bin_dir,
        dylib,
        frameworks,
    })
}

/// Copies the LiveKit dylib and its frameworks into Contents/Frameworks;
/// `ditto` keeps the symlinks inside a framework bundle.
fn embed_calling_seam(seam: &CallingSeam, frameworks_dir: &Path) -> Result<(), String> {
    let dylib_target = frameworks_dir.join("libTriOSLiveKit.dylib");
    let _ = fs::remove_file(&dylib_target);
    fs::copy(&seam.dylib, &dylib_target)
        .map_err(|e| format!("copy {}: {}", seam.dylib.display(), e))?;
    for framework in &seam.frameworks {
        let name = framework
            .file_name()
            .ok_or_else(|| format!("framework without a name: {}", framework.display()))?;
        let target = frameworks_dir.join(name);
        if target.exists() {
            fs::remove_dir_all(&target)
                .map_err(|e| format!("remove {}: {}", target.display(), e))?;
        }
        let status = Command::new("ditto")
            .arg(framework)
            .arg(&target)
            .status()
            .map_err(|e| format!("ditto failed to start: {}", e))?;
        if !status.success() {
            return Err(format!("ditto {} failed", framework.display()));
        }
    }
    Ok(())
}

fn run_pkg_config(arg: &str) -> Result<String, String> {
    let output = Command::new("pkg-config")
        .arg(arg)
        .arg("sqlcipher")
        .output()
        .map_err(|e| format!("pkg-config failed: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "pkg-config {} sqlcipher failed: {}",
            arg,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    String::from_utf8(output.stdout)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("invalid utf8 from pkg-config: {}", e))
}

fn find_sqlcipher_dylib(lib_dir: &str) -> Result<PathBuf, String> {
    let entries = fs::read_dir(lib_dir)
        .map_err(|e| format!("read SQLCipher lib dir {}: {}", lib_dir, e))?;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        // Use the real versioned file (e.g. libsqlcipher.3.53.3.dylib), not symlinks.
        if name.starts_with("libsqlcipher.") && name.ends_with(".dylib") {
            if path.symlink_metadata()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                continue;
            }
            return Ok(path);
        }
    }
    Err(format!("No SQLCipher dynamic library found in {}", lib_dir))
}

fn bundle_sqlcipher_dylib(source: &Path, dest: &Path, binary: &Path) -> Result<(), String> {
    let _ = fs::remove_file(dest);
    fs::copy(source, dest).map_err(|e| {
        format!(
            "copy {} to {}: {}",
            source.display(),
            dest.display(),
            e
        )
    })?;
    let mut perms = fs::metadata(dest)
        .map_err(|e| format!("metadata {}: {}", dest.display(), e))?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(dest, perms)
        .map_err(|e| format!("chmod {}: {}", dest.display(), e))?;
    run_install_name_tool(&[
        "-id",
        "@rpath/libsqlcipher.dylib",
        dest.to_str().unwrap_or_default(),
    ],
    "set dylib id")?;
    run_install_name_tool(
        &[
            "-change",
            "/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib",
            "@rpath/libsqlcipher.dylib",
            binary.to_str().unwrap_or_default(),
        ],
        "patch binary rpath",
    )?;
    Ok(())
}

fn run_install_name_tool(args: &[&str], context: &str) -> Result<(), String> {
    let output = Command::new("install_name_tool")
        .args(args)
        .output()
        .map_err(|e| format!("install_name_tool {} failed: {}", context, e))?;
    if !output.status.success() {
        return Err(format!(
            "install_name_tool {}: {}",
            context,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

fn resolve_variant(name: &str) -> Variant {
    if name == "staging" {
        Variant {
            name: "staging",
            output: PathBuf::from(format!("{}/.worktrees/staging/trios_app", &project_dir())),
            app_bundle: PathBuf::from(format!("{}/.worktrees/staging/trios-staging.app", &project_dir())),
            bundle_id: "com.browseros.trios.staging",
            mcp_port: "9205",
            a2a_port: "9300",
            mesh_port: "9505",
            canary_mcp_port: "9205",
            build_root: PathBuf::from(format!("{}/.worktrees/staging/trios", &project_dir())),
        }
    } else {
        Variant {
            name: "prod",
            output: PathBuf::from(format!("{}/trios_app", &project_dir())),
            app_bundle: PathBuf::from(format!("{}/trios.app", &project_dir())),
            bundle_id: "com.browseros.trios",
            mcp_port: "9105",
            a2a_port: "9200",
            mesh_port: "9505",
            canary_mcp_port: "9205",
            build_root: PathBuf::from(&project_dir()),
        }
    }
}

fn collect_swift_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            collect_swift_files(&path, out);
        } else if path.extension().map(|e| e == "swift").unwrap_or(false) {
            out.push(path);
        }
    }
}

/// Only include the production BR-OUTPUT files that build.sh compiles.
/// Untracked BR-OUTPUT prototypes must not break the app build.
fn collect_lean_br_output(dir: &Path, out: &mut Vec<PathBuf>) {
    const LEAN_BR_OUTPUT: &[&str] = &[
        "A2AMessageRouter.swift",
        "BrowserOSChatViewModel.swift",
        "ChatLogic.swift",
        "ChatPanelView.swift",
        "ChatSidebarView.swift",
        "CladeGuard.swift",
        "FullscreenChatWorkspace.swift",
        "GitButlerPanelView.swift",
        "GitButlerViewModel.swift",
        "GitHubAPIClient.swift",
        "GitHubDashboardView.swift",
        "GitHubModels.swift",
        "GitWorkspaceView.swift",
        "GlassmorphismBackground.swift",
        "HotkeyBar.swift",
        "LLMClient.swift",
        "LogsTabView.swift",
        "MenuBuilder.swift",
        "MeshAuth.swift",
        "MeshChatListView.swift",
        "MeshChatModels.swift",
        "MeshChatThreadView.swift",
        "MeshChatView.swift",
        "MeshChatViewModel.swift",
        "MeshModels.swift",
        "MeshStatusViewModel.swift",
        "MeshTabView.swift",
        // Internet calls; compiled empty unless -D TRIOS_CALLS (internet-calls.md).
        "InternetCallsModel.swift",
        "InternetCallsView.swift",
        "MessageBubbleView.swift",
        "ModelsTabView.swift",
        "ProjectPaths.swift",
        "QueenStatusViewModel.swift",
        "QueenTabView.swift",
        "RecursionGuard.swift",
        "RichTextRenderer.swift",
        "ServerManager.swift",
        "SessionGuard.swift",
        "SmoothStreamingEnhancements.swift",
        "TODOAnimations.swift",
        "TODOListView.swift",
        "TerminalTabView.swift",
        "ToolCallCardView.swift",
        "TriosMCPClient.swift",
        "TriosTabView.swift",
        "TriosTheme.swift",
        "TypingIndicatorView.swift",
        "WindowManager.swift",
    ];
    for name in LEAN_BR_OUTPUT {
        let path = dir.join(name);
        if path.is_file() {
            out.push(path);
        }
    }
}

fn queen_package_root() -> Result<PathBuf, String> {
    let project = PathBuf::from(project_dir());
    let trinity_root = if let Ok(root) = env::var("TRINITY_ROOT") {
        PathBuf::from(root)
    } else {
        let ancestor = project
            .parent()
            .and_then(|p| p.parent())
            .ok_or_else(|| "Cannot derive TRINITY_ROOT from project directory; set TRINITY_ROOT".to_string())?;
        ancestor.join("trinity")
    };
    let queen_pkg = trinity_root.join("apps/queen");
    if !queen_pkg.join("Package.swift").is_file() {
        return Err(format!(
            "Canonical Queen package not found: {}. Set TRINITY_ROOT to the gHashTag/trinity checkout.",
            queen_pkg.display()
        ));
    }
    Ok(queen_pkg)
}

fn build_queen_lib() -> Result<String, String> {
    let queen_pkg = queen_package_root()?;

    if env::var("TRIOS_REUSE_QUEEN_BUILD").is_err() {
        println!("[CladeBuild] Building QueenUILib at {}", queen_pkg.display());
        let output = Command::new("swift")
            .arg("build")
            .arg("--package-path")
            .arg(&queen_pkg)
            .arg("--product")
            .arg("QueenUILib")
            .output()
            .map_err(|e| format!("swift build failed to start: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "QueenUILib build failed:\n{}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    } else {
        println!("[CladeBuild] Reusing existing QueenUILib build");
    }

    let output = Command::new("swift")
        .arg("build")
        .arg("--package-path")
        .arg(&queen_pkg)
        .arg("--show-bin-path")
        .output()
        .map_err(|e| format!("swift build --show-bin-path failed to start: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "swift build --show-bin-path failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let bin_path = String::from_utf8(output.stdout)
        .map_err(|e| format!("invalid UTF-8 from swift build: {}", e))?;
    let bin_path = bin_path.trim();
    let dylib = Path::new(bin_path).join("libQueenUILib.dylib");
    if !dylib.is_file() {
        return Err(format!("QueenUILib was not produced: {}", dylib.display()));
    }
    Ok(bin_path.to_string())
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capitalize_empty() {
        assert_eq!(capitalize(""), "");
    }

    #[test]
    fn capitalize_single_char() {
        assert_eq!(capitalize("a"), "A");
    }

    #[test]
    fn capitalize_word() {
        assert_eq!(capitalize("staging"), "Staging");
    }

    #[test]
    fn capitalize_already_upper() {
        assert_eq!(capitalize("Prod"), "Prod");
    }

    #[test]
    fn resolve_variant_prod() {
        let v = resolve_variant("prod");
        assert_eq!(v.name, "prod");
        assert_eq!(v.mcp_port, "9105");
        assert_eq!(v.a2a_port, "9200");
        assert_eq!(v.mesh_port, "9505");
        assert_eq!(v.canary_mcp_port, "9205");
        assert_eq!(v.bundle_id, "com.browseros.trios");
    }

    #[test]
    fn resolve_variant_staging() {
        let v = resolve_variant("staging");
        assert_eq!(v.name, "staging");
        assert_eq!(v.mcp_port, "9205");
        assert_eq!(v.a2a_port, "9300");
        assert_eq!(v.mesh_port, "9505");
        assert_eq!(v.canary_mcp_port, "9205");
        assert_eq!(v.bundle_id, "com.browseros.trios.staging");
    }

    #[test]
    fn resolve_variant_unknown_defaults_to_prod() {
        let v = resolve_variant("anything");
        assert_eq!(v.name, "prod");
    }
}
