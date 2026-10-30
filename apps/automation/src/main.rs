mod engine;
mod store;
use std::{
    io::{self, Read},
    path::PathBuf,
};

fn main() {
    let result = (|| {
        let mut root = PathBuf::from("/etc/i7y/automation");
        let mut principal = None;
        let mut worker = None;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--root" => root = PathBuf::from(args.next().ok_or("Missing controller root")?),
                "--principal" => principal = Some(args.next().ok_or("Missing operator identity")?),
                "--worker" => worker = Some(args.next().ok_or("Missing operation ID")?),
                _ => return Err("Unsupported executor argument".into()),
            }
        }
        let engine = engine::Engine::open(
            root.canonicalize()
                .map_err(|_| "Controller configuration unavailable")?,
            principal.ok_or("A restricted operator identity is required")?,
        )?;
        if let Some(id) = worker {
            engine.work(&id)?;
            return Ok(serde_json::json!({"worker_finished":true}));
        }
        let mut input = String::new();
        io::stdin()
            .take(16385)
            .read_to_string(&mut input)
            .map_err(|_| "Unable to read request")?;
        if input.len() > 16384 {
            return Err("Request is too large".into());
        }
        let envelope: engine::Envelope =
            serde_json::from_str(&input).map_err(|_| "Invalid executor request")?;
        if envelope.version != 1 {
            return Err("Unsupported executor protocol".into());
        }
        engine.check_scope(&envelope.backend, &envelope.organization)?;
        engine.handle(envelope.request)
    })();
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            println!("{}", serde_json::json!({"error":error}));
            std::process::exit(1);
        }
    }
}
