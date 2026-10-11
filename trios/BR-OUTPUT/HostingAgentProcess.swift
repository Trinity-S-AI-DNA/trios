// HostingAgentProcess.swift -- the I/O half of lending this Mac to the Queen
// (gHashTag/trios#1756): fetch and check the agent, run it, read it, stop it.
//
// THIN GLUE. Every decision in this file is a call into the hosting card,
// gHashTag/t27 specs/hosting/panel.t27, which `make hosting-card` turns into
// C and Swift imports as T27HostingPanel: which download is kept
// (agent_kept), which URL may be fetched (fetch_allowed), whether the key
// file is private (key_file_private), which child argument names a spec
// (names_spec), how CPU ticks become milliseconds (cpu_millis). This file
// downloads, hashes, spawns, signals and reads. It decides nothing.
//
// NO KEY IN HERE. The host key lives in the agent's own key file, mode 0600,
// in TRIOS_HOST_HOME. This file never opens it: it asks only whether it
// exists and what its mode is, so that `trios-host key` is never the thing
// that makes one.

import CryptoKit
import Darwin
import Foundation
import T27HostingPanel

/// A Swift string from one of the card's words.
func hostingCardText(_ word: UnsafePointer<CChar>?) -> String {
    guard let word else { return "" }
    return String(cString: word)
}

enum HostingAgentError: Error, CustomStringConvertible {
    case urlRefused(String)
    case download(String)
    case refused(digest: String, bytes: UInt64)
    case notInstalled
    case spawn(String)

    var description: String {
        switch self {
        case .urlRefused(let url): return "the hosting card does not allow fetching \(url)"
        case .download(let why): return "download failed: \(why)"
        case .refused(let digest, let bytes):
            return "refused: the download is not the pinned agent (sha256 \(digest), \(bytes) bytes)"
        case .notInstalled: return "the agent is not installed"
        case .spawn(let why): return "the agent did not start: \(why)"
        }
    }
}

/// Where the agent's binary is, and the home it runs in.
struct HostingAgentPlace: Equatable {
    /// The checked binary: ProjectPaths.hostingAgentBinary.
    let binary: URL
    /// TRIOS_HOST_HOME; empty for the agent's own default, AGENT_DIR under the user's home.
    let home: String

    /// The home the agent will use, spelled out.
    var effectiveHome: String {
        home.isEmpty ? "\(NSHomeDirectory())/\(AGENT_DIR)" : home
    }

    var keyFile: String { "\(effectiveHome)/\(KEY_FILE)" }

    var keyFileExists: Bool { FileManager.default.fileExists(atPath: keyFile) }

    /// The key file's mode, read with stat; the file itself is never opened.
    var keyFileMode: UInt32? {
        var info = stat()
        guard stat(keyFile, &info) == 0 else { return nil }
        return UInt32(info.st_mode)
    }

    /// The agent's environment: the few variables a process needs, and its home. No other
    /// variable of the app's own reaches it.
    var environment: [String: String] {
        let mine = ProcessInfo.processInfo.environment
        var env: [String: String] = [:]
        for name in ["PATH", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME"] {
            if let value = mine[name] { env[name] = value }
        }
        if env["PATH"] == nil { env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin" }
        if env["HOME"] == nil { env["HOME"] = NSHomeDirectory() }
        if !home.isEmpty { env["TRIOS_HOST_HOME"] = home }
        return env
    }
}

enum HostingAgentInstaller {
    /// SHA-256 of a file, lowercase hex, and its size.
    static func digest(of url: URL) throws -> (hex: String, bytes: UInt64) {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        var bytes: UInt64 = 0
        while true {
            let chunk = try handle.read(upToCount: 1 << 20) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
            bytes += UInt64(chunk.count)
        }
        let hex = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        return (hex, bytes)
    }

    /// Whether the installed binary is still the pinned file. Asked before every start.
    static func installedIsKept(_ binary: URL) -> Bool {
        guard let found = try? digest(of: binary) else { return false }
        return agent_kept(found.hex, found.bytes)
    }

    /// Fetch the agent from its release and keep it only when the card keeps it.
    static func install(to binary: URL) async throws {
        let address = AGENT_URL
        guard fetch_allowed(address), let url = URL(string: address) else {
            throw HostingAgentError.urlRefused(address)
        }
        let downloaded: URL
        do {
            (downloaded, _) = try await URLSession.shared.download(from: url)
        } catch {
            throw HostingAgentError.download(error.localizedDescription)
        }
        let found: (hex: String, bytes: UInt64)
        do {
            found = try digest(of: downloaded)
        } catch {
            try? FileManager.default.removeItem(at: downloaded)
            throw HostingAgentError.download(error.localizedDescription)
        }
        guard agent_kept(found.hex, found.bytes) else {
            try? FileManager.default.removeItem(at: downloaded)
            throw HostingAgentError.refused(digest: found.hex, bytes: found.bytes)
        }
        let fm = FileManager.default
        try fm.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
        if fm.fileExists(atPath: binary.path) { try fm.removeItem(at: binary) }
        try fm.moveItem(at: downloaded, to: binary)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
    }
}

/// One run of `trios-host`: started, read line by line, signalled, reaped.
final class HostingAgentProcess {
    private let process = Process()
    private var pending = Data()
    private let lock = NSLock()
    private let onLine: (String) -> Void
    private let onExit: (Int32) -> Void

    init(
        binary: URL,
        arguments: [String],
        environment: [String: String],
        onLine: @escaping (String) -> Void,
        onExit: @escaping (Int32) -> Void
    ) {
        process.executableURL = binary
        process.arguments = arguments
        process.environment = environment
        process.currentDirectoryURL = URL(fileURLWithPath: NSTemporaryDirectory())
        self.onLine = onLine
        self.onExit = onExit
    }

    var pid: pid_t { process.processIdentifier }
    var isRunning: Bool { process.isRunning }

    func start() throws {
        let out = Pipe()
        process.standardOutput = out
        process.standardError = out
        process.standardInput = FileHandle.nullDevice
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            self?.take(data)
        }
        process.terminationHandler = { [weak self] proc in
            out.fileHandleForReading.readabilityHandler = nil
            if let rest = try? out.fileHandleForReading.readToEnd(), !rest.isEmpty {
                self?.take(rest)
            }
            self?.flush()
            let status = proc.terminationStatus
            DispatchQueue.main.async { self?.onExit(status) }
        }
        do {
            try process.run()
        } catch {
            throw HostingAgentError.spawn(error.localizedDescription)
        }
    }

    private func take(_ data: Data) {
        lock.lock()
        pending.append(data)
        var lines: [String] = []
        while let cut = pending.firstIndex(of: 0x0A) {
            let line = pending[pending.startIndex..<cut]
            lines.append(String(decoding: line, as: UTF8.self))
            pending.removeSubrange(pending.startIndex...cut)
        }
        lock.unlock()
        guard !lines.isEmpty else { return }
        DispatchQueue.main.async { [onLine] in lines.forEach(onLine) }
    }

    private func flush() {
        lock.lock()
        let rest = pending
        pending.removeAll()
        lock.unlock()
        guard !rest.isEmpty else { return }
        let line = String(decoding: rest, as: UTF8.self)
        DispatchQueue.main.async { [onLine] in onLine(line) }
    }

    /// SIGTERM: the agent stops its loop and exits (trios-host.ts `quit`).
    func terminate() {
        guard process.isRunning else { return }
        kill(process.processIdentifier, SIGTERM)
    }

    /// SIGTERM, then SIGKILL once the grace has passed. Blocks: it is what quit calls.
    func stopBlocking(graceSeconds: UInt32) {
        guard process.isRunning else { return }
        let pid = process.processIdentifier
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(TimeInterval(graceSeconds))
        while process.isRunning && Date() < deadline {
            usleep(50_000)
        }
        if process.isRunning {
            kill(pid, SIGKILL)
            process.waitUntilExit()
        }
    }
}

/// What the OS says about a running agent: its CPU time and the jobs it runs now.
enum HostingAgentProbe {
    /// The agent's CPU time, its own and its finished jobs', in milliseconds (card cpu_millis).
    static func cpuMillis(pid: pid_t) -> UInt64? {
        var info = rusage_info_v4()
        let rc = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
                proc_pid_rusage(pid, RUSAGE_INFO_V4, $0)
            }
        }
        guard rc == 0 else { return nil }
        var timebase = mach_timebase_info_data_t()
        mach_timebase_info(&timebase)
        return cpu_millis(
            info.ri_user_time,
            info.ri_system_time,
            info.ri_child_user_time,
            info.ri_child_system_time,
            timebase.numer,
            timebase.denom
        )
    }

    /// The executable a process runs, or nil when there is no such process.
    static func executablePath(of pid: pid_t) -> String? {
        guard pid > 0 else { return nil }
        var buffer = [CChar](repeating: 0, count: 4096)
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return String(cString: buffer)
    }

    /// The agent's direct children: each one is a job it runs now.
    static func children(of pid: pid_t) -> [pid_t] {
        let room = 64
        var pids = [pid_t](repeating: 0, count: room)
        let bytes = pids.withUnsafeMutableBytes {
            proc_listpids(UInt32(PROC_PPID_ONLY), UInt32(pid), $0.baseAddress, Int32($0.count))
        }
        guard bytes > 0 else { return [] }
        let count = min(Int(bytes) / MemoryLayout<pid_t>.size, room)
        return pids.prefix(count).filter { $0 > 0 }
    }

    /// A process's arguments, from KERN_PROCARGS2.
    static func arguments(of pid: pid_t) -> [String] {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return [] }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return [] }
        let argc = buffer.withUnsafeBytes { $0.load(as: Int32.self) }
        var at = MemoryLayout<Int32>.size
        while at < size && buffer[at] != 0 { at += 1 }
        while at < size && buffer[at] == 0 { at += 1 }
        var args: [String] = []
        while args.count < Int(argc) && at < size {
            let start = at
            while at < size && buffer[at] != 0 { at += 1 }
            args.append(String(decoding: buffer[start..<at], as: UTF8.self))
            at += 1
        }
        return args
    }

    /// The specs the agent's jobs run now: each child's argument the card says names a spec.
    static func runningSpecs(of pid: pid_t) -> (jobs: Int, specs: [String]) {
        let kids = children(of: pid)
        var specs: [String] = []
        for kid in kids {
            for arg in arguments(of: kid) where names_spec(arg) {
                specs.append(arg)
            }
        }
        return (kids.count, specs)
    }
}

/// The agent's one-shot commands: `key` and `statement`.
enum HostingAgentCommand {
    struct Outcome {
        let ran: Bool
        let exitCode: Int32
        let output: String
    }

    /// Run the agent with these arguments and wait at most `seconds` for it.
    static func run(_ place: HostingAgentPlace, _ arguments: [String], seconds: TimeInterval) async -> Outcome {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let process = Process()
                process.executableURL = place.binary
                process.arguments = arguments
                process.environment = place.environment
                process.currentDirectoryURL = URL(fileURLWithPath: NSTemporaryDirectory())
                let out = Pipe()
                process.standardOutput = out
                process.standardError = FileHandle.nullDevice
                process.standardInput = FileHandle.nullDevice
                do {
                    try process.run()
                } catch {
                    continuation.resume(returning: Outcome(ran: false, exitCode: -1, output: ""))
                    return
                }
                let timer = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + seconds, execute: timer)
                let data = (try? out.fileHandleForReading.readToEnd()) ?? Data()
                process.waitUntilExit()
                timer.cancel()
                continuation.resume(returning: Outcome(
                    ran: true,
                    exitCode: process.terminationStatus,
                    output: String(decoding: data, as: UTF8.self)
                ))
            }
        }
    }
}
