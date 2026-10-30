use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Component, Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CopySpec {
    pub source_root: PathBuf,
    pub source_domain: String,
    pub destination_domain: String,
    pub database_image_id: String,
    pub web_image_id: String,
}

pub struct DatabaseCredentials {
    user: String,
    database: String,
    password: String,
    root_password: String,
}
impl DatabaseCredentials {
    pub fn generate(destination_domain: &str) -> Result<Self> {
        if !domain(destination_domain) {
            return Err("Invalid destination domain".into());
        }
        let mut entropy = [0u8; 64];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(&mut entropy))
            .map_err(|_| "Secure random source unavailable")?;
        let token = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let suffix = hex_hash(destination_domain.as_bytes());
        Ok(Self {
            user: format!("i7y_{}", &suffix[..12]),
            database: format!("i7y_{}", &suffix[..12]),
            password: token(&entropy[..32]),
            root_password: token(&entropy[32..]),
        })
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CopyPreview {
    pub source_domain: String,
    pub destination_domain: String,
    pub source_root: PathBuf,
    pub destination_root: PathBuf,
    pub compose_project: String,
    pub database_service: String,
    pub web_service: String,
    pub database_volume: String,
    pub wordpress_relative_path: PathBuf,
    pub source_image_references: BTreeMap<String, String>,
    pub pinned_images: BTreeMap<String, String>,
}
pub struct PreparedCopy {
    pub preview: CopyPreview,
    compose: Value,
}
impl PreparedCopy {
    pub fn write_private_compose(&self, mut output: impl std::io::Write) -> Result<()> {
        serde_json::to_writer_pretty(&mut output, &self.compose)
            .map_err(|_| "Unable to write destination Compose configuration".into())
    }
}
fn hex_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn domain(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}
fn image_id(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .map(|v| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
        .unwrap_or(false)
}
fn clean_path(path: &Path) -> bool {
    path.is_absolute()
        && path.components().count() > 2
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        && path
            .to_str()
            .map(|s| !s.contains(['\0', '\n', '\r', ':']))
            .unwrap_or(false)
}
fn object(value: &Value) -> Result<&Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| "Unsupported Compose configuration".into())
}
fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
}
fn external(definition: &Value) -> bool {
    definition
        .get("external")
        .map(|v| v == true || v.is_object())
        .unwrap_or(false)
}
fn network_names(service: &Value) -> Result<Vec<String>> {
    match service.get("networks") {
        Some(Value::Object(values)) => Ok(values.keys().cloned().collect()),
        Some(Value::Array(values)) => values
            .iter()
            .map(|v| {
                v.as_str()
                    .map(String::from)
                    .ok_or_else(|| "Unsupported service networks".into())
            })
            .collect(),
        None => Ok(vec!["default".into()]),
        _ => Err("Unsupported service networks".into()),
    }
}
fn environment(service: &Value) -> Result<Map<String, Value>> {
    let values = service
        .get("environment")
        .ok_or("A resolved service environment is required")?;
    let map = object(values)?;
    if map
        .values()
        .any(|v| !v.is_string() && !v.is_number() && !v.is_boolean())
    {
        return Err("Compose environment must be fully resolved".into());
    }
    Ok(map.clone())
}
fn rewrite_mount(
    value: &Value,
    spec: &CopySpec,
    destination: &Path,
    volumes: &BTreeMap<String, String>,
) -> Result<(Value, String)> {
    let (source, target, mode, long) = if let Some(text) = value.as_str() {
        let parts: Vec<_> = text.split(':').collect();
        if parts.len() < 2 || parts.len() > 3 {
            return Err("Anonymous or unsupported volumes cannot be copied".into());
        }
        (
            parts[0].to_string(),
            parts[1].to_string(),
            parts.get(2).copied().unwrap_or("rw").to_string(),
            None,
        )
    } else {
        let data = object(value)?;
        if data.keys().any(|k| {
            ![
                "type",
                "source",
                "target",
                "read_only",
                "bind",
                "volume",
                "consistency",
            ]
            .contains(&k.as_str())
        }) {
            return Err("Unsupported mount option".into());
        }
        let source = data
            .get("source")
            .and_then(Value::as_str)
            .ok_or("Mount source is required")?;
        let target = data
            .get("target")
            .and_then(Value::as_str)
            .ok_or("Mount target is required")?;
        if !matches!(
            data.get("type").and_then(Value::as_str),
            Some("volume" | "bind")
        ) {
            return Err("Unsupported mount type".into());
        }
        (
            source.into(),
            target.into(),
            if data.get("read_only") == Some(&Value::Bool(true)) {
                "ro"
            } else {
                "rw"
            }
            .into(),
            Some(data.clone()),
        )
    };
    if !target.starts_with('/')
        || Path::new(&target)
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
        || target.contains(['\0', '\n', '\r', ':'])
        || !["ro", "rw"].contains(&mode.as_str())
    {
        return Err("Unsupported mount target or access mode".into());
    }
    let rewritten = if let Some(volume) = volumes.get(&source) {
        volume.clone()
    } else {
        let path = Path::new(&source);
        if !clean_path(path) {
            return Err("Only project-owned absolute bind mounts are supported".into());
        }
        let relative = path
            .strip_prefix(&spec.source_root)
            .map_err(|_| "A mount escapes the source project")?;
        destination
            .join(relative)
            .to_str()
            .ok_or("Unsupported destination path")?
            .into()
    };
    if let Some(mut map) = long {
        map.insert("source".into(), json!(rewritten));
        Ok((Value::Object(map), target))
    } else {
        Ok((json!(format!("{rewritten}:{target}:{mode}")), target))
    }
}

pub fn prepare(
    source: &Value,
    spec: &CopySpec,
    credentials: &DatabaseCredentials,
) -> Result<PreparedCopy> {
    if !domain(&spec.source_domain)
        || !domain(&spec.destination_domain)
        || spec.source_domain == spec.destination_domain
        || !clean_path(&spec.source_root)
        || spec.source_root.file_name().and_then(|v| v.to_str())
            != Some(spec.source_domain.as_str())
        || !image_id(&spec.database_image_id)
        || !image_id(&spec.web_image_id)
    {
        return Err("Invalid copy source, destination or image identity".into());
    }
    let source_root = &spec.source_root;
    let destination = source_root
        .parent()
        .ok_or("Invalid project root")?
        .join(&spec.destination_domain);
    let slug: String = spec
        .destination_domain
        .chars()
        .take(32)
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let project = format!(
        "i7y-{slug}-{}",
        &hex_hash(spec.destination_domain.as_bytes())[..8]
    );
    let database_service = format!("{project}-db");
    let web_service = format!("{project}-web");
    let root = object(source)?;
    if root
        .keys()
        .any(|k| !["version", "services", "volumes", "networks"].contains(&k.as_str()))
    {
        return Err("Unsupported top-level Compose extension".into());
    }
    let services = object(
        root.get("services")
            .ok_or("Compose services are required")?,
    )?;
    if services.len() != 2 || services.keys().any(|k| !name(k)) {
        return Err(
            "The initial copy adapter requires one web service and one MySQL service".into(),
        );
    }
    let databases: Vec<_> = services
        .iter()
        .filter(|(_, s)| {
            s.get("image")
                .and_then(Value::as_str)
                .map(|v| v.starts_with("mysql:") || v.starts_with("mysql@"))
                .unwrap_or(false)
        })
        .collect();
    if spec.database_image_id == spec.web_image_id {
        return Err("Database and web images must have distinct identities".into());
    }
    if databases.len() != 1 {
        return Err("Exactly one supported MySQL service is required".into());
    }
    let (database_key, database) = databases[0];
    let (web_key, web) = services
        .iter()
        .find(|(key, _)| *key != database_key)
        .ok_or("Web service unavailable")?;
    let networks = root
        .get("networks")
        .map(object)
        .transpose()?
        .cloned()
        .unwrap_or_default();
    if network_names(database)?
        .iter()
        .any(|n| networks.get(n).map(external).unwrap_or(false))
    {
        return Err("The source database must not use an external network".into());
    }
    let mut destination_networks = Map::new();
    for (key, definition) in &networks {
        if !name(key) {
            return Err("Unsupported network name".into());
        }
        let mut definition = if definition.is_null() {
            Map::new()
        } else {
            object(definition)?.clone()
        };
        if !external(&Value::Object(definition.clone())) {
            if definition
                .get("driver_opts")
                .map(|v| v.as_object().map(|m| !m.is_empty()).unwrap_or(true))
                .unwrap_or(false)
            {
                return Err("Custom network drivers require a dedicated adapter".into());
            }
            definition.remove("name");
        }
        destination_networks.insert(key.clone(), Value::Object(definition));
    }
    let definitions = object(
        root.get("volumes")
            .ok_or("An independent named database volume is required")?,
    )?;
    if definitions.len() != 1 {
        return Err("Additional named volumes require a dedicated data-copy adapter".into());
    }
    let mut volume_names = BTreeMap::new();
    let mut destination_volumes = Map::new();
    for (key, definition) in definitions {
        if !name(key) || external(definition) {
            return Err("External or unsupported volumes cannot be copied".into());
        }
        let definition = if definition.is_null() {
            Map::new()
        } else {
            object(definition)?.clone()
        };
        if definition
            .keys()
            .any(|k| !["name", "driver", "driver_opts", "external", "labels"].contains(&k.as_str()))
            || definition
                .get("driver")
                .and_then(Value::as_str)
                .map(|v| v != "local")
                .unwrap_or(false)
            || definition
                .get("driver_opts")
                .map(|v| v.as_object().map(|m| !m.is_empty()).unwrap_or(true))
                .unwrap_or(false)
        {
            return Err("Only default local volumes are supported".into());
        }
        let renamed = format!("data_{}", &hex_hash(key.as_bytes())[..12]);
        volume_names.insert(key.clone(), renamed.clone());
        destination_volumes.insert(renamed, json!({"driver":"local"}));
    }
    let service_names = BTreeMap::from([
        (database_key.clone(), database_service.clone()),
        (web_key.clone(), web_service.clone()),
    ]);
    let mut output_services = Map::new();
    let mut database_volume = None;
    let mut wordpress_relative_path = None;
    for (old_name, service) in services {
        let mut service = object(service)?.clone();
        for forbidden in [
            "build",
            "extends",
            "env_file",
            "secrets",
            "configs",
            "network_mode",
            "pid",
            "ipc",
            "devices",
            "cap_add",
            "volumes_from",
            "extra_hosts",
            "entrypoint",
            "command",
            "healthcheck",
            "post_start",
            "pre_stop",
        ] {
            if service
                .get(forbidden)
                .map(|v| !v.is_null())
                .unwrap_or(false)
            {
                return Err(format!("Unsupported service option: {forbidden}"));
            }
        }
        if service.get("privileged") == Some(&Value::Bool(true))
            || service
                .get("ports")
                .map(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(true))
                .unwrap_or(false)
        {
            return Err(
                "Privileged containers and published host ports require a dedicated adapter".into(),
            );
        }
        if service
            .get("labels")
            .map(|v| v.as_object().map(|m| !m.is_empty()).unwrap_or(true))
            .unwrap_or(false)
        {
            return Err("Custom routing labels require a dedicated adapter".into());
        }
        let is_database = old_name == database_key;
        let mut env = environment(&Value::Object(service.clone()))?;
        if env.keys().any(|key| {
            matches!(key.as_str(), "DATABASE_URL" | "MYSQL_URL") || key.ends_with("_PASSWORD_FILE")
        }) {
            return Err("External database credentials require a dedicated adapter".into());
        }

        for key in ["MYSQL_HOST", "WORDPRESS_DB_HOST", "DB_HOST"] {
            if env.contains_key(key) {
                env.insert(key.into(), json!(database_service));
            }
        }
        for (key, value) in [
            ("MYSQL_DATABASE", &credentials.database),
            ("MYSQL_USER", &credentials.user),
            ("MYSQL_PASSWORD", &credentials.password),
        ] {
            env.insert(key.into(), json!(value));
        }
        if is_database {
            for key in [
                "MYSQL_RANDOM_ROOT_PASSWORD",
                "MYSQL_ALLOW_EMPTY_PASSWORD",
                "MYSQL_ONETIME_PASSWORD",
            ] {
                env.remove(key);
            }
            env.insert(
                "MYSQL_ROOT_PASSWORD".into(),
                json!(credentials.root_password),
            );
        } else {
            env.remove("MYSQL_ROOT_PASSWORD");
            env.insert("VIRTUAL_HOST".into(), json!(spec.destination_domain));
            if env.contains_key("LETSENCRYPT_HOST") {
                env.insert("LETSENCRYPT_HOST".into(), json!(spec.destination_domain));
            }
            for (key, value) in [
                ("WORDPRESS_DB_NAME", &credentials.database),
                ("WORDPRESS_DB_USER", &credentials.user),
                ("WORDPRESS_DB_PASSWORD", &credentials.password),
                ("DB_NAME", &credentials.database),
                ("DB_USER", &credentials.user),
                ("DB_PASSWORD", &credentials.password),
            ] {
                if env.contains_key(key) {
                    env.insert(key.into(), json!(value));
                }
            }
        }
        let mounts = service
            .get("volumes")
            .and_then(Value::as_array)
            .ok_or("Service mounts are required")?;
        let mut rewritten = Vec::new();
        for mount in mounts {
            let (value, target) = rewrite_mount(mount, spec, &destination, &volume_names)?;
            if target == "/var/lib/mysql" {
                if !is_database || database_volume.is_some() {
                    return Err("Database storage cannot be shared between services".into());
                }
                let source = if let Some(v) = mount.as_str() {
                    v.split(':').next().unwrap_or("")
                } else {
                    mount["source"].as_str().unwrap_or("")
                };
                database_volume = Some(
                    volume_names
                        .get(source)
                        .ok_or("A named database volume is required")?
                        .clone(),
                );
            }
            if !is_database {
                let source = if let Some(v) = mount.as_str() {
                    v.split(':').next().unwrap_or("")
                } else {
                    mount["source"].as_str().unwrap_or("")
                };
                if Path::new(source) == source_root.join("app") {
                    let document_root = env
                        .get("WEB_DOCUMENT_ROOT")
                        .and_then(Value::as_str)
                        .ok_or("A WordPress document root is required")?;
                    let relative = Path::new(document_root)
                        .strip_prefix(&target)
                        .map_err(|_| "Document root is outside the application mount")?;
                    if relative
                        .components()
                        .any(|c| !matches!(c, Component::Normal(_)))
                    {
                        return Err("Unsupported document root".into());
                    }
                    wordpress_relative_path = Some(PathBuf::from("app").join(relative));
                }
            }
            rewritten.push(value);
        }
        service.insert("volumes".into(), json!(rewritten));
        service.insert("environment".into(), Value::Object(env));
        let renamed = service_names
            .get(old_name)
            .ok_or("Invalid service mapping")?;
        service.insert("container_name".into(), json!(renamed));
        service.insert(
            "image".into(),
            json!(if is_database {
                &spec.database_image_id
            } else {
                &spec.web_image_id
            }),
        );
        if let Some(depends) = service.get_mut("depends_on") {
            if let Some(list) = depends.as_array_mut() {
                for value in list {
                    let mapped = service_names
                        .get(value.as_str().ok_or("Invalid service dependency")?)
                        .ok_or("External service dependency is unsupported")?;
                    *value = json!(mapped);
                }
            } else if let Some(map) = depends.as_object_mut() {
                let old = std::mem::take(map);
                for (name, value) in old {
                    map.insert(
                        service_names
                            .get(&name)
                            .ok_or("Invalid service dependency")?
                            .clone(),
                        value,
                    );
                }
            } else {
                return Err("Unsupported dependency configuration".into());
            }
        }
        if let Some(links) = service.get_mut("links") {
            for link in links.as_array_mut().ok_or("Unsupported service links")? {
                let value = link.as_str().ok_or("Unsupported service link")?;
                let parts: Vec<_> = value.split(':').collect();
                let target = service_names
                    .get(parts[0])
                    .ok_or("External service link is unsupported")?;
                *link = json!(target);
            }
        }
        output_services.insert(renamed.clone(), Value::Object(service));
    }
    let database_volume = database_volume.ok_or("A named MySQL data mount is required")?;
    let wordpress_relative_path =
        wordpress_relative_path.ok_or("Application document root is not mapped to the project")?;
    let mut compose = json!({"services":output_services,"volumes":destination_volumes,"networks":destination_networks});
    if let Some(version) = root.get("version") {
        compose["version"] = version.clone();
    }
    let references = BTreeMap::from([
        (
            "database".into(),
            database["image"].as_str().unwrap_or("").into(),
        ),
        ("web".into(), web["image"].as_str().unwrap_or("").into()),
    ]);
    let pins = BTreeMap::from([
        ("database".into(), spec.database_image_id.clone()),
        ("web".into(), spec.web_image_id.clone()),
    ]);
    Ok(PreparedCopy {
        preview: CopyPreview {
            source_domain: spec.source_domain.clone(),
            destination_domain: spec.destination_domain.clone(),
            source_root: source_root.clone(),
            destination_root: destination,
            compose_project: project,
            database_service,
            web_service,
            database_volume,
            wordpress_relative_path,
            source_image_references: references,
            pinned_images: pins,
        },
        compose,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn credentials() -> DatabaseCredentials {
        DatabaseCredentials {
            user: "new_user".into(),
            database: "new_database".into(),
            password: "new-application-secret".into(),
            root_password: "new-root-secret".into(),
        }
    }
    fn spec() -> CopySpec {
        CopySpec {
            source_root: "/srv/projects/source.example.com".into(),
            source_domain: "source.example.com".into(),
            destination_domain: "copy.example.com".into(),
            database_image_id: format!("sha256:{}", "a".repeat(64)),
            web_image_id: format!("sha256:{}", "b".repeat(64)),
        }
    }
    fn model() -> Value {
        json!({
            "version":"3.7",
            "services":{
                "source-db":{"container_name":"source-db","image":"mysql:5.7","environment":{"MYSQL_DATABASE":"old_database","MYSQL_USER":"old_user","MYSQL_PASSWORD":"source-application-secret","MYSQL_ROOT_PASSWORD":"source-root-secret"},"volumes":["source_data:/var/lib/mysql:rw","/srv/projects/source.example.com/app:/var/www/app:rw"],"networks":{"internal":null}},
                "source-web":{"container_name":"source-web","image":"example/php-nginx:8.3","environment":{"MYSQL_DATABASE":"old_database","MYSQL_USER":"old_user","MYSQL_PASSWORD":"source-application-secret","MYSQL_ROOT_PASSWORD":"source-root-secret","VIRTUAL_HOST":"source.example.com","WEB_DOCUMENT_ROOT":"/var/www/app/public"},"volumes":["/srv/projects/source.example.com/app:/var/www/app:rw","/srv/projects/source.example.com/.security/php.ini:/usr/local/etc/php/conf.d/security.ini:ro"],"networks":{"internal":null,"proxy":null},"depends_on":["source-db"],"links":["source-db"]}
            },
            "volumes":{"source_data":{"driver":"local","name":"shared-old-volume"}},
            "networks":{"internal":{"driver":"bridge","name":"old-internal-network"},"proxy":{"external":{"name":"shared-proxy"}}}
        })
    }
    #[test]
    fn independent_configuration_preserves_source_and_rewrites_every_resource() {
        let source = model();
        let before = source.clone();
        let prepared = prepare(&source, &spec(), &credentials()).unwrap();
        assert_eq!(source, before);
        let database = &prepared.compose["services"][&prepared.preview.database_service];
        let web = &prepared.compose["services"][&prepared.preview.web_service];
        assert_eq!(database["image"], spec().database_image_id);
        assert_eq!(web["image"], spec().web_image_id);
        assert_eq!(web["environment"]["VIRTUAL_HOST"], "copy.example.com");
        assert!(web["environment"].get("MYSQL_ROOT_PASSWORD").is_none());
        assert_eq!(
            database["environment"]["MYSQL_ROOT_PASSWORD"],
            "new-root-secret"
        );
        assert_eq!(
            web["environment"]["MYSQL_PASSWORD"],
            "new-application-secret"
        );
        assert_eq!(web["depends_on"][0], prepared.preview.database_service);
        assert_eq!(web["links"][0], prepared.preview.database_service);
        assert_eq!(
            prepared.preview.wordpress_relative_path,
            Path::new("app/public")
        );
        assert!(web["volumes"][1]
            .as_str()
            .unwrap()
            .starts_with("/srv/projects/copy.example.com/.security/"));
        assert!(prepared.compose["networks"]["internal"]
            .get("name")
            .is_none());
        assert_eq!(
            prepared.compose["networks"]["proxy"]["external"]["name"],
            "shared-proxy"
        );
        assert_eq!(prepared.compose["volumes"].as_object().unwrap().len(), 1);
        assert!(!prepared.compose.to_string().contains("shared-old-volume"));
        let preview = serde_json::to_string(&prepared.preview).unwrap();
        for secret in [
            "source-application-secret",
            "source-root-secret",
            "new-application-secret",
            "new-root-secret",
            "new_user",
        ] {
            assert!(!preview.contains(secret));
        }
        let mut bytes = Vec::new();
        prepared.write_private_compose(&mut bytes).unwrap();
        let private = String::from_utf8(bytes).unwrap();
        assert!(!private.contains("source-application-secret"));
        assert!(!private.contains("source-root-secret"));
    }
    #[test]
    fn reject_shared_storage_external_database_networks_and_unsafe_services() {
        let base = model();
        let mut cases = Vec::new();
        let mut m = base.clone();
        m["volumes"]["source_data"]["external"] = json!(true);
        cases.push(m);
        let mut m = base.clone();
        m["services"]["source-db"]["networks"] = json!(["proxy"]);
        cases.push(m);
        let mut m = base.clone();
        m["services"]["source-web"]["volumes"][0] =
            json!("/srv/projects/source.example.com-other/app:/var/www/app:rw");
        cases.push(m);
        let mut m = base.clone();
        m["services"]["source-web"]["privileged"] = json!(true);
        cases.push(m);
        let mut m = base.clone();
        m["services"]["source-web"]["ports"] = json!(["8080:80"]);
        cases.push(m);
        let mut m = base.clone();
        m["services"]["source-web"]["network_mode"] = json!("host");
        cases.push(m);
        let mut m = base.clone();
        m["services"]["source-web"]["command"] = json!("modify-source");
        cases.push(m);
        let mut m = base.clone();
        m["services"]["source-web"]["environment"]["DATABASE_URL"] = json!("mysql://old-database");
        cases.push(m);
        let mut m = base.clone();
        m["services"]["source-db"]["volumes"][0] =
            json!("/srv/projects/source.example.com/database:/var/lib/mysql:rw");
        cases.push(m);
        let mut m = base.clone();
        m["volumes"]["uploads"] = json!({});
        cases.push(m);
        for (index, m) in cases.iter().enumerate() {
            assert!(
                prepare(m, &spec(), &credentials()).is_err(),
                "Unsafe layout {index} was accepted"
            );
        }
    }
    #[test]
    fn supports_normalized_long_mounts_and_rejects_invalid_domains() {
        let mut source = model();
        source["services"]["source-web"]["volumes"] = json!([{"type":"bind","source":"/srv/projects/source.example.com/app","target":"/var/www/app","read_only":false},{"type":"bind","source":"/srv/projects/source.example.com/.security/php.ini","target":"/etc/php/security.ini","read_only":true}]);
        let prepared = prepare(&source, &spec(), &credentials()).unwrap();
        let mounts = &prepared.compose["services"][&prepared.preview.web_service]["volumes"];
        assert_eq!(mounts[0]["source"], "/srv/projects/copy.example.com/app");
        assert_eq!(mounts[1]["read_only"], true);
        for value in [
            "../copy.example.com",
            "copy.example.com;id",
            "source.example.com",
            "https://copy.example.com",
        ] {
            let mut invalid = spec();
            invalid.destination_domain = value.into();
            assert!(prepare(&source, &invalid, &credentials()).is_err());
        }
    }
    #[test]
    fn generated_credentials_are_independent_and_not_predictable_from_domain() {
        let one = DatabaseCredentials::generate("copy.example.com").unwrap();
        let two = DatabaseCredentials::generate("copy.example.com").unwrap();
        assert_eq!(one.password.len(), 64);
        assert_ne!(one.password, one.root_password);
        assert_ne!(one.password, two.password);
        assert_eq!(one.database, two.database);
        assert!(one.user.len() <= 32);
    }
}
