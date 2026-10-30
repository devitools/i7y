use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const MAX_CONTROLLER_RESPONSE_BYTES: usize = 65536;

const DIAGNOSTIC: &str = "printf 'i7y-controller-v1\\n'; printf 'os='; uname -s; printf 'arch='; uname -m; printf 'ansible='; if command -v ansible >/dev/null 2>&1; then ansible --version 2>/dev/null | head -n 1; else printf 'unavailable\\n'; fi; printf 'runner='; if command -v ansible-runner >/dev/null 2>&1; then ansible-runner --version 2>/dev/null; else printf 'unavailable\\n'; fi";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ControllerProfile {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub public_key: String,
    pub host_key: String,
    #[serde(default)]
    pub identity_file: String,
    #[serde(default, skip_serializing)]
    pub agent_endpoint: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub operating_system: String,
    pub architecture: String,
    pub ansible_version: Option<String>,
    pub runner_version: Option<String>,
    pub host_fingerprint: String,
    pub identity_fingerprint: String,
    pub execution_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SshError {
    InvalidProfile,
    InvalidPublicKey,
    HostKeyMismatch,
    AuthenticationDenied,
    AgentUnavailable,
    OpenSshUnavailable,
    ConnectionFailed,
    TimedOut,
    InvalidDiagnostic,
    ResponseTooLarge,
    LocalStorageFailed,
}

fn key_bytes(value: &str) -> Result<Vec<u8>, SshError> {
    if value.len() > 8192 || value.contains(['\n', '\r', '\0']) {
        return Err(SshError::InvalidPublicKey);
    }
    let fields: Vec<_> = value.split_whitespace().collect();
    if fields.len() != 2
        || ![
            "ssh-ed25519",
            "ecdsa-sha2-nistp256",
            "ecdsa-sha2-nistp384",
            "ecdsa-sha2-nistp521",
            "ssh-rsa",
        ]
        .contains(&fields[0])
    {
        return Err(SshError::InvalidPublicKey);
    }
    let bytes = STANDARD
        .decode(fields[1])
        .map_err(|_| SshError::InvalidPublicKey)?;
    if bytes.len() < 8 {
        return Err(SshError::InvalidPublicKey);
    }
    let length = u32::from_be_bytes(
        bytes[..4]
            .try_into()
            .map_err(|_| SshError::InvalidPublicKey)?,
    ) as usize;
    if bytes.get(4..4 + length) != Some(fields[0].as_bytes()) {
        return Err(SshError::InvalidPublicKey);
    }
    let mut remaining = &bytes[4 + length..];
    let mut field = || -> Result<Vec<u8>, SshError> {
        if remaining.len() < 4 {
            return Err(SshError::InvalidPublicKey);
        }
        let length = u32::from_be_bytes(
            remaining[..4]
                .try_into()
                .map_err(|_| SshError::InvalidPublicKey)?,
        ) as usize;
        let value = remaining
            .get(4..4 + length)
            .ok_or(SshError::InvalidPublicKey)?
            .to_vec();
        remaining = &remaining[4 + length..];
        Ok(value)
    };
    match fields[0] {
        "ssh-ed25519" => {
            if field()?.len() != 32 {
                return Err(SshError::InvalidPublicKey);
            }
        }
        "ssh-rsa" => {
            if field()?.is_empty() || field()?.len() < 128 {
                return Err(SshError::InvalidPublicKey);
            }
        }
        curve => {
            if field()? != curve.trim_start_matches("ecdsa-sha2-").as_bytes() || field()?.len() < 33
            {
                return Err(SshError::InvalidPublicKey);
            }
        }
    }
    if !remaining.is_empty() {
        return Err(SshError::InvalidPublicKey);
    }
    Ok(bytes)
}

pub fn fingerprint(key: &str) -> Result<String, SshError> {
    let digest = Sha256::digest(key_bytes(key)?);
    Ok(format!(
        "SHA256:{}",
        STANDARD.encode(digest).trim_end_matches('=')
    ))
}

pub fn canonical_key(value: &str) -> Result<String, SshError> {
    let value = value.trim();
    if value.len() > 16384 {
        return Err(SshError::InvalidPublicKey);
    }
    if value.contains(['\n', '\r', '\0']) {
        return Err(SshError::InvalidPublicKey);
    }
    let fields: Vec<_> = value.split_whitespace().collect();
    if fields.len() < 2 {
        return Err(SshError::InvalidPublicKey);
    }
    let key = format!("{} {}", fields[0], fields[1]);
    key_bytes(&key)?;
    Ok(key)
}

impl ControllerProfile {
    pub fn validate(&self) -> Result<(), SshError> {
        if self.port == 0 {
            return Err(SshError::InvalidProfile);
        }
        if self.host.is_empty()
            || self.host.len() > 253
            || self.host.starts_with(['-', '.'])
            || !self
                .host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_:".contains(&b))
        {
            return Err(SshError::InvalidProfile);
        }
        if self.user.is_empty()
            || self.user.len() > 64
            || self.user.starts_with('-')
            || !self
                .user
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(SshError::InvalidProfile);
        }
        key_bytes(&self.public_key)?;
        key_bytes(&self.host_key)?;
        if self.identity_file.len() > 4096
            || self.identity_file.contains(['\n', '\r', '\0', '"', '%', '$', '`'])
            || !Path::new(&self.identity_file).is_absolute()
        {
            return Err(SshError::InvalidProfile);
        }
        Ok(())
    }
    pub fn known_host_entry(&self) -> Result<String, SshError> {
        self.validate()?;
        let host = if self.port == 22 {
            self.host.clone()
        } else {
            format!("[{}]:{}", self.host, self.port)
        };
        Ok(format!("{host} {}\n", self.host_key))
    }
}

pub fn ssh_arguments(
    profile: &ControllerProfile,
    identity: &Path,
    known_hosts: &Path,
) -> Result<Vec<OsString>, SshError> {
    profile.validate()?;
    let mut args: Vec<OsString> = vec![
        "-F".into(),
        if cfg!(windows) { "NUL" } else { "/dev/null" }.into(),
        "-T".into(),
        "-a".into(),
        "-x".into(),
    ];
    for option in [
        "BatchMode=yes",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "PreferredAuthentications=publickey",
        "IdentitiesOnly=yes",
        "StrictHostKeyChecking=yes",
        "UpdateHostKeys=no",
        "VerifyHostKeyDNS=no",
        "ForwardAgent=no",
        "ClearAllForwardings=yes",
        "PermitLocalCommand=no",
        "ControlMaster=no",
        "ControlPath=none",
        "ConnectTimeout=10",
        "ConnectionAttempts=1",
        "ServerAliveInterval=5",
        "ServerAliveCountMax=2",
    ] {
        args.extend(["-o".into(), option.into()]);
    }
    for path in [identity, known_hosts] {
        if path
            .to_string_lossy()
            .contains(['\n', '\r', '\0', '"', '%', '$', '`'])
        {
            return Err(SshError::InvalidProfile);
        }
    }
    args.extend([
        "-o".into(),
        format!("UserKnownHostsFile=\"{}\"", known_hosts.display()).into(),
        "-o".into(),
        format!(
            "GlobalKnownHostsFile={}",
            if cfg!(windows) { "NUL" } else { "/dev/null" }
        )
        .into(),
        "-i".into(),
        Path::new(&profile.identity_file).as_os_str().into(),
        "-p".into(),
        profile.port.to_string().into(),
        "-l".into(),
        profile.user.clone().into(),
        "--".into(),
        profile.host.clone().into(),
        DIAGNOSTIC.into(),
    ]);
    Ok(args)
}

pub fn system_ssh() -> Result<PathBuf, SshError> {
    #[cfg(windows)]
    let path = PathBuf::from(std::env::var_os("SystemRoot").ok_or(SshError::OpenSshUnavailable)?)
        .join("System32/OpenSSH/ssh.exe");
    #[cfg(not(windows))]
    let path = PathBuf::from("/usr/bin/ssh");
    if !path.is_file() {
        return Err(SshError::OpenSshUnavailable);
    }
    Ok(path)
}

fn bounded_read(mut reader: impl Read) -> (Vec<u8>, bool) {
    let mut result = Vec::new();
    let mut oversized = false;
    let mut chunk = [0u8; 4096];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                let remaining = MAX_CONTROLLER_RESPONSE_BYTES.saturating_sub(result.len());
                oversized |= size > remaining;
                result.extend_from_slice(&chunk[..size.min(remaining)]);
            }
        }
    }
    (result, oversized)
}

pub fn classify_failure(stderr: &str) -> SshError {
    let text = stderr.to_ascii_lowercase();
    if text.contains("host key verification failed")
        || text.contains("remote host identification has changed")
    {
        SshError::HostKeyMismatch
    } else if text.contains("agent refused")
        || text.contains("error connecting to agent")
        || text.contains("communication with agent failed")
    {
        SshError::AgentUnavailable
    } else if text.contains("permission denied") {
        SshError::AuthenticationDenied
    } else {
        SshError::ConnectionFailed
    }
}

pub fn parse_diagnostic(output: &str, profile: &ControllerProfile) -> Result<Diagnostic, SshError> {
    let lines: Vec<_> = output.lines().collect();
    if lines.len() != 5 || lines[0] != "i7y-controller-v1" {
        return Err(SshError::InvalidDiagnostic);
    }
    let mut values = BTreeMap::new();
    for line in &lines[1..] {
        let (key, value) = line.split_once('=').ok_or(SshError::InvalidDiagnostic)?;
        if value.len() > 120
            || !value.is_ascii()
            || value.chars().any(char::is_control)
            || values.insert(key, value).is_some()
        {
            return Err(SshError::InvalidDiagnostic);
        }
    }
    let os = *values.get("os").ok_or(SshError::InvalidDiagnostic)?;
    let arch = *values.get("arch").ok_or(SshError::InvalidDiagnostic)?;
    if os != "Linux" || !["x86_64", "aarch64"].contains(&arch) {
        return Err(SshError::InvalidDiagnostic);
    }
    let version = |key| -> Result<Option<String>, SshError> {
        let value = *values.get(key).ok_or(SshError::InvalidDiagnostic)?;
        Ok(if value == "unavailable" || value.is_empty() {
            None
        } else {
            Some(value.to_string())
        })
    };
    Ok(Diagnostic {
        operating_system: os.into(),
        architecture: arch.into(),
        ansible_version: version("ansible")?,
        runner_version: version("runner")?,
        host_fingerprint: fingerprint(&profile.host_key)?,
        identity_fingerprint: fingerprint(&profile.public_key)?,
        execution_enabled: false,
    })
}

pub fn diagnose(
    profile: &ControllerProfile,
    identity: &Path,
    known_hosts: &Path,
) -> Result<Diagnostic, SshError> {
    let (success, output, errors) = run(profile, identity, known_hosts, false, None)?;
    if !success {
        return Err(classify_failure(&errors));
    }
    parse_diagnostic(&output, profile)
}

pub(crate) fn run(
    profile: &ControllerProfile,
    identity: &Path,
    known_hosts: &Path,
    executor: bool,
    input: Option<Vec<u8>>,
) -> Result<(bool, String, String), SshError> {
    run_command(profile, identity, known_hosts, if executor { Some("/usr/local/bin/i7y-automation") } else { None }, input)
}

fn run_command(profile: &ControllerProfile, identity: &Path, known_hosts: &Path, remote: Option<&str>, input: Option<Vec<u8>>) -> Result<(bool, String, String), SshError> {
    let mut args = ssh_arguments(profile, identity, known_hosts)?;
    if let Some(remote) = remote {
        args.pop();
        args.push(remote.into());
    }
    let mut command = Command::new(system_ssh()?);
    command
        .args(args)
        .env("LC_ALL", "C")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| SshError::OpenSshUnavailable)?;
    let stdout = child.stdout.take().ok_or(SshError::ConnectionFailed)?;
    let stderr = child.stderr.take().ok_or(SshError::ConnectionFailed)?;
    let out = thread::spawn(move || bounded_read(stdout));
    let err = thread::spawn(move || bounded_read(stderr));
    let writer = match input {
        Some(input) => {
            let mut stdin = child.stdin.take().ok_or(SshError::ConnectionFailed)?;
            Some(thread::spawn(move || stdin.write_all(&input)))
        }
        None => None,
    };
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| SshError::ConnectionFailed)? {
            break status;
        }
        if start.elapsed() > Duration::from_secs(30) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out.join();
            let _ = err.join();
            if let Some(writer) = writer {
                let _ = writer.join();
            }
            return Err(SshError::TimedOut);
        }
        thread::sleep(Duration::from_millis(50));
    };
    let (output, oversized) = out.join().map_err(|_| SshError::ConnectionFailed)?;
    let (errors, _) = err.join().map_err(|_| SshError::ConnectionFailed)?;
    if let Some(writer) = writer {
        let written = writer.join().map_err(|_| SshError::ConnectionFailed)?;
        if status.success() {
            written.map_err(|_| SshError::ConnectionFailed)?;
        }
    }
    if oversized {
        return Err(SshError::ResponseTooLarge);
    }
    let output = String::from_utf8(output).map_err(|_| SshError::InvalidDiagnostic)?;
    let errors = String::from_utf8_lossy(&errors).to_string();
    Ok((status.success(), output, errors))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn response_reader_detects_overflow_at_the_complete_frame_boundary() {
        let (exact, oversized) =
            bounded_read(std::io::Cursor::new(vec![
                b'x';
                MAX_CONTROLLER_RESPONSE_BYTES
            ]));
        assert_eq!(exact.len(), MAX_CONTROLLER_RESPONSE_BYTES);
        assert!(!oversized);
        let (prefix, oversized) = bounded_read(std::io::Cursor::new(vec![
            b'x';
            MAX_CONTROLLER_RESPONSE_BYTES
                + 1
        ]));
        assert_eq!(prefix.len(), MAX_CONTROLLER_RESPONSE_BYTES);
        assert!(oversized);
    }
    fn key(seed: u8) -> String {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&11u32.to_be_bytes());
        bytes.extend_from_slice(b"ssh-ed25519");
        bytes.extend_from_slice(&32u32.to_be_bytes());
        bytes.extend_from_slice(&[seed; 32]);
        format!("ssh-ed25519 {}", STANDARD.encode(bytes))
    }
    fn profile() -> ControllerProfile {
        ControllerProfile {
            host: "controller.example.com".into(),
            port: 10222,
            user: "operator".into(),
            public_key: key(1),
            host_key: key(2),
            identity_file: if cfg!(windows) { "C:/keys/id_ed25519".into() } else { "/tmp/id_ed25519".into() },
            agent_endpoint: if cfg!(windows) {
                "//./pipe/openssh-ssh-agent".into()
            } else {
                "/tmp/ssh-agent.sock".into()
            },
        }
    }
    #[test]
    fn rejects_options_and_shell_injection_in_connection_fields() {
        for host in [
            "-oProxyCommand=evil",
            "host;touch /tmp/file",
            "host\nProxyCommand evil",
            "user@host",
            "../../host",
            "$(id)",
        ] {
            let mut p = profile();
            p.host = host.into();
            assert_eq!(p.validate(), Err(SshError::InvalidProfile));
        }
        for user in ["-root", "user;id", "user\nroot", "$(id)"] {
            let mut p = profile();
            p.user = user.into();
            assert_eq!(p.validate(), Err(SshError::InvalidProfile));
        }
        let mut p = profile();
        p.identity_file = "/tmp/key\" ProxyCommand=evil".into();
        assert_eq!(p.validate(), Err(SshError::InvalidProfile));
        p = profile();
        p.port = 0;
        assert_eq!(p.validate(), Err(SshError::InvalidProfile));
    }
    #[test]
    fn accepts_only_structurally_valid_public_keys() {
        let valid = key(3);
        assert_eq!(
            canonical_key(&format!("{valid} operator@example.com")).unwrap(),
            valid
        );
        assert!(canonical_key("-----BEGIN OPENSSH PRIVATE KEY-----").is_err());
        assert!(canonical_key("ssh-ed25519 invalid-base64").is_err());
        assert!(canonical_key(&format!("{valid}\n{valid}")).is_err());
        let mut malformed = STANDARD
            .decode(valid.split_whitespace().nth(1).unwrap())
            .unwrap();
        malformed.pop();
        assert!(fingerprint(&format!("ssh-ed25519 {}", STANDARD.encode(malformed))).is_err());
        assert_ne!(fingerprint(&key(1)).unwrap(), fingerprint(&key(2)).unwrap());
        assert!(fingerprint(&valid).unwrap().starts_with("SHA256:"));
    }
    #[test]
    fn pins_host_identity_and_uses_local_identity() {
        let p = profile();
        assert_eq!(
            p.known_host_entry().unwrap(),
            format!("[controller.example.com]:10222 {}\n", p.host_key)
        );
        let args = ssh_arguments(
            &p,
            Path::new("/tmp/public.pub"),
            Path::new("/tmp/known_hosts"),
        )
        .unwrap();
        let strings: Vec<_> = args.iter().map(|a| a.to_string_lossy()).collect();
        for required in [
            "StrictHostKeyChecking=yes",
            "UpdateHostKeys=no",
            "PasswordAuthentication=no",
            "KbdInteractiveAuthentication=no",
            "IdentitiesOnly=yes",
            "ForwardAgent=no",
            "PermitLocalCommand=no",
            "BatchMode=yes",
            "ClearAllForwardings=yes",
            "ControlMaster=no",
        ] {
            assert!(strings.iter().any(|a| a == required));
        }
        assert_eq!(strings.last().unwrap().as_ref(), DIAGNOSTIC);
        assert!(!DIAGNOSTIC.contains("sudo"));
        assert!(!DIAGNOSTIC.contains(" up "));
        assert!(!DIAGNOSTIC.contains("ansible-playbook"));
    }
    #[test]
    fn diagnostics_never_enable_remote_changes() {
        let result=parse_diagnostic("i7y-controller-v1\nos=Linux\narch=x86_64\nansible=ansible [core 2.18.1]\nrunner=unavailable\n",&profile()).unwrap();
        assert_eq!(result.ansible_version, Some("ansible [core 2.18.1]".into()));
        assert!(result.runner_version.is_none());
        assert!(!result.execution_enabled);
        assert!(parse_diagnostic(
            "banner\ni7y-controller-v1\nos=Linux\narch=x86_64\nansible=2\nrunner=2",
            &profile()
        )
        .is_err());
        assert!(parse_diagnostic(
            "i7y-controller-v1\nos=Linux\narch=x86_64\narch=aarch64\nrunner=2",
            &profile()
        )
        .is_err());
        assert!(parse_diagnostic(
            "i7y-controller-v1\nos=Darwin\narch=arm64\nansible=2\nrunner=2",
            &profile()
        )
        .is_err());
    }
    #[test]
    fn reports_refused_authentication_and_changed_host_keys_without_raw_logs() {
        assert_eq!(
            classify_failure("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!"),
            SshError::HostKeyMismatch
        );
        assert_eq!(
            classify_failure("Permission denied (publickey)"),
            SshError::AuthenticationDenied
        );
        assert_eq!(
            classify_failure("sign_and_send_pubkey: signing failed: agent refused operation"),
            SshError::AgentUnavailable
        );
        assert_eq!(
            classify_failure("Connection refused"),
            SshError::ConnectionFailed
        );
    }
    #[test]
    fn bounds_output_while_continuing_to_drain_the_pipe() {
        let (output, oversized) = bounded_read(std::io::Cursor::new(vec![1u8; 100000]));
        assert_eq!(output.len(), MAX_CONTROLLER_RESPONSE_BYTES);
        assert!(oversized);
    }
    #[test]
    #[cfg(unix)]
    fn emits_a_real_line_break_in_the_fixed_protocol_header() {
        let header = DIAGNOSTIC.split(';').next().unwrap();
        let output = Command::new("/bin/sh")
            .args(["-c", header])
            .output()
            .unwrap();
        assert_eq!(output.stdout, b"i7y-controller-v1\n");
    }
    #[test]
    #[cfg(unix)]
    fn installed_openssh_accepts_the_hardened_configuration_offline() {
        let p = profile();
        let executable = system_ssh().unwrap();
        let mut args = vec![OsString::from("-G")];
        args.extend(
            ssh_arguments(
                &p,
                Path::new("/tmp/i7y-public.pub"),
                Path::new("/tmp/i7y-known-hosts"),
            )
            .unwrap(),
        );
        let result = Command::new(executable).args(args).output().unwrap();
        assert!(
            result.status.success(),
            "OpenSSH rejected the diagnostic configuration"
        );
        let config = String::from_utf8(result.stdout).unwrap();
        assert!(config.contains("forwardagent no"));
        assert!(config.contains("stricthostkeychecking true"));
        assert!(config.contains("identitiesonly yes"));
    }
}

pub fn ansible_ping(profile: &ControllerProfile, known_hosts: &Path, address: &str, port: u16) -> Result<bool, SshError> {
    let address: std::net::Ipv4Addr = address.parse().map_err(|_| SshError::InvalidProfile)?;
    if port == 0 { return Err(SshError::InvalidProfile); }
    let remote = format!("env LC_ALL=C ANSIBLE_HOST_KEY_CHECKING=True ansible -i '{address},' all -u root -e ansible_port={port} -m ping -T 10 --ssh-common-args='-o StrictHostKeyChecking=yes -o BatchMode=yes -o ForwardAgent=no'");
    let (success, output, errors) = run_command(profile, Path::new(&profile.identity_file), known_hosts, Some(&remote), None)?;
    if !success && (errors.contains("Permission denied") || errors.contains("Host key verification failed")) { return Err(classify_failure(&errors)); }
    Ok(success && output.contains("\"ping\": \"pong\""))
}

#[cfg(test)]
mod ping_tests {
    use super::*;
    #[test]
    fn rejects_inventory_patterns_and_shell_input_before_connecting() {
        let profile = ControllerProfile { host: "tools.example.com".into(), port: 22, user: "operator".into(), public_key: String::new(), host_key: String::new(), identity_file: "/tmp/key".into(), agent_endpoint: String::new() };
        for address in ["all", "*", "192.0.2.1;id", "192.0.2.1,192.0.2.2", "$(id)"] {
            assert_eq!(ansible_ping(&profile, Path::new("/tmp/known_hosts"), address, 22), Err(SshError::InvalidProfile));
        }
        assert_eq!(ansible_ping(&profile, Path::new("/tmp/known_hosts"), "192.0.2.1", 0), Err(SshError::InvalidProfile));
    }
}
