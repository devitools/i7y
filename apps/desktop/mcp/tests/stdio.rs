#[cfg(all(target_os = "macos", debug_assertions))]
mod fixture {
    use serde_json::{json, Value};
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::{fs::PermissionsExt, net::UnixListener},
        path::PathBuf,
        process::{Child, Command, Stdio},
        sync::atomic::{AtomicUsize, Ordering},
        time::{Duration, Instant},
    };

    struct Desktop {
        directory: PathBuf,
        connector: PathBuf,
        server: Option<Child>,
    }

    impl Desktop {
        fn start(mode: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let directory = PathBuf::from("/tmp").join(format!(
                "i7y-stdio-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&directory).unwrap();
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
            let directory = directory.canonicalize().unwrap();
            let connector = directory.join("i7y-mcp");
            let mut fixture = Self {
                directory,
                connector,
                server: None,
            };
            std::fs::copy(env!("CARGO_BIN_EXE_i7y-mcp"), &fixture.connector).unwrap();
            let desktop = fixture.directory.join("i7y-desktop");
            std::fs::copy(std::env::current_exe().unwrap(), &desktop).unwrap();
            fixture.server = Some(
                Command::new(desktop)
                    .args([
                        "--exact",
                        "fixture::mock_desktop_socket_helper",
                        "--ignored",
                        "--nocapture",
                    ])
                    .env("TMPDIR", &fixture.directory)
                    .env("I7Y_STDIO_TEST_MODE", mode)
                    .env("I7Y_STDIO_TEST_DIRECTORY", &fixture.directory)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap(),
            );
            let started = Instant::now();
            while !fixture.directory.join("ready").exists() {
                assert!(
                    fixture
                        .server
                        .as_mut()
                        .unwrap()
                        .try_wait()
                        .unwrap()
                        .is_none(),
                    "Mock desktop exited before opening its socket"
                );
                assert!(started.elapsed() < Duration::from_secs(10));
                std::thread::sleep(Duration::from_millis(10));
            }
            fixture
        }

        fn connector(&self) -> Child {
            Command::new(&self.connector)
                .env("TMPDIR", &self.directory)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        }

        fn transcript(&mut self) -> Vec<Value> {
            assert!(self.server.take().unwrap().wait().unwrap().success());
            serde_json::from_slice(&std::fs::read(self.directory.join("transcript.json")).unwrap())
                .unwrap()
        }
    }

    impl Drop for Desktop {
        fn drop(&mut self) {
            if let Some(mut server) = self.server.take() {
                let _ = server.kill();
                let _ = server.wait();
            }
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    #[ignore = "Subprocess-only mock desktop selected by the macOS debug stdio fixtures"]
    fn mock_desktop_socket_helper() {
        let directory = PathBuf::from(std::env::var_os("I7Y_STDIO_TEST_DIRECTORY").unwrap());
        assert_eq!(
            std::env::current_exe().unwrap(),
            directory.join("i7y-desktop")
        );
        let mode = std::env::var("I7Y_STDIO_TEST_MODE").unwrap();
        assert!(["roundtrip", "malformed"].contains(&mode.as_str()));
        let endpoint = i7y_mcp::socket_path();
        std::fs::create_dir_all(endpoint.parent().unwrap()).unwrap();
        let listener = UnixListener::bind(endpoint).unwrap();
        listener.set_nonblocking(true).unwrap();
        std::fs::write(directory.join("ready"), b"ready").unwrap();
        let started = Instant::now();
        let (mut socket, _) = loop {
            match listener.accept() {
                Ok(socket) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(started.elapsed() < Duration::from_secs(10));
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("Mock desktop accept failed: {error}"),
            }
        };
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        let mut transcript = Vec::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            let value: Value = serde_json::from_str(&line).unwrap();
            transcript.push(value.clone());
            if mode == "malformed" {
                socket
                    .write_all(b"invalid json\n{\"unsafe\":\"stale-tool-result\"}\n")
                    .unwrap();
                let _ = reader.read_line(&mut String::new());
                break;
            }
            let response = if value["method"] == "connect" {
                json!({"state":"approval_required","request_id":"request"})
            } else {
                json!({"authorized":false})
            };
            writeln!(socket, "{response}").unwrap();
        }
        std::fs::write(
            directory.join("transcript.json"),
            serde_json::to_vec(&transcript).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn stdio_roundtrip_preserves_protocol_and_rejects_untyped_arguments() {
        let mut desktop = Desktop::start("roundtrip");
        let mut child = desktop.connector();
        let mut input = child.stdin.take().unwrap();
        for request in [
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"declared client","version":"test"}}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_servers","arguments":{"filter":"arbitrary"}}}),
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"connection_status","arguments":{}}}),
        ] {
            writeln!(input, "{request}").unwrap();
        }
        drop(input);
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let rows: Vec<Value> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0]["result"]["serverInfo"]["name"], "i7y-desktop");
        assert!(rows[1]["result"]["tools"].as_array().unwrap().len() >= 28);
        assert!(rows[2].get("error").is_some());
        assert_eq!(rows[3]["id"], 4);
        let transcript = desktop.transcript();
        assert_eq!(transcript.len(), 2);
        assert_eq!(transcript[0]["client"]["name"], "declared client");
        assert_eq!(transcript[1]["name"], "connection_status");
    }

    #[test]
    fn invalid_local_response_cannot_be_reused_as_the_next_tool_result() {
        let mut desktop = Desktop::start("malformed");
        let mut child = desktop.connector();
        let mut input = child.stdin.take().unwrap();
        writeln!(input,"{}",json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"fixture"}}})).unwrap();
        writeln!(input,"{}",json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"connection_status","arguments":{}}})).unwrap();
        drop(input);
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        let rows: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row.get("error").is_some()));
        assert!(!text.contains("stale-tool-result"));
        let transcript = desktop.transcript();
        assert_eq!(transcript.len(), 1);
        assert_eq!(transcript[0]["method"], "connect");
    }
}
