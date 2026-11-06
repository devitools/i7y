import copy
import hashlib
import ipaddress
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit


class CopyError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise CopyError(message)


def domain(value):
    return isinstance(value, str) and len(value) <= 253 and '.' in value and all(
        re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part)
        for part in value.split('.'))


def replace_domain(value, source, destination):
    pattern = r'(?<![a-z0-9-])' + re.escape(source) + r'(?![a-z0-9.-])'
    return re.sub(pattern, lambda match: destination, value, flags=re.IGNORECASE)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def command(args, timeout=60):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise CopyError('Unable to inspect Docker resources')
    require(result.returncode == 0, 'Docker inspection failed')
    return result.stdout.decode()


def private_json(path, value):
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())


def replace_json(path, value):
    temporary = path.with_name(path.name + '.pending')
    if temporary.exists():
        temporary.unlink()
    private_json(temporary, value)
    os.replace(str(temporary), str(path))


def manifest(root):
    result = []
    for directory, dirs, files in os.walk(str(root), followlinks=False):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode), 'Unsupported symlink or special file in source project')
            require(not info.st_mode & (stat.S_ISUID | stat.S_ISGID), 'Unsupported privileged file in source project')
            checksum = None
            if stat.S_ISREG(info.st_mode):
                hasher = hashlib.sha256()
                with path.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        hasher.update(chunk)
                checksum = hasher.hexdigest()
            result.append([str(path.relative_to(root)), info.st_mode, info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, checksum])
    return sorted(result)


def source_root(value, source_domain):
    path = Path(value)
    require(re.fullmatch(r'/[a-zA-Z0-9_./-]+', value) is not None and path.is_absolute() and '..' not in path.parts and len(path.parts) > 2, 'Source must be an absolute project directory')
    require(path.resolve() == path and path.is_dir(), 'Source directory must not contain symbolic links')
    if path.name == 'app' and path.parent.name == source_domain:
        path = path.parent
    require(path.name == source_domain, 'Source directory must match the source domain')
    return path


def environment(container):
    values = container['Config'].get('Env') or []
    return dict(value.split('=', 1) for value in values if '=' in value)


def model(root, source_domain, destination_domain, containers):
    require(domain(source_domain) and domain(destination_domain) and source_domain != destination_domain, 'Provide distinct valid source and destination domains')
    require(len(containers) == 2, 'Copy requires exactly one running web container and one MySQL container')
    require(all(c['State'].get('Running') for c in containers), 'Both source containers must be running')
    databases = [c for c in containers if re.match(r'(?:docker.io/library/)?mysql:5\.7(?:[.@-]|$)', c['Config'].get('Image', ''))]
    require(len(databases) == 1, 'Copy requires a MySQL 5.7 database')
    db = databases[0]
    web = next(c for c in containers if c['Id'] != db['Id'])
    for container in containers:
        require(re.fullmatch(r'[a-f0-9]{64}', container['Id']) is not None, 'Invalid container identity')
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', container['Image']) is not None, 'Invalid image identity')
        host = container['HostConfig']
        require(not host.get('Privileged') and not host.get('Devices') and not host.get('CapAdd'), 'Privileged source containers or custom devices and capabilities are unsupported')
        require(host.get('NetworkMode') not in ('host', 'none') and not str(host.get('NetworkMode', '')).startswith('container:'), 'Unsupported source networking')
        require(not container['Config'].get('Labels', {}).get('com.docker.compose.oneoff') == 'True', 'One-off containers cannot be copied')
    dbmounts = db.get('Mounts', [])
    data_mounts = [mount for mount in dbmounts if mount['Destination'] == '/var/lib/mysql']
    require(len(data_mounts) == 1 and data_mounts[0]['Type'] == 'volume', 'Database must have one independent named data volume')
    for mount in dbmounts:
        if mount is data_mounts[0]:
            continue
        source = Path(mount.get('Source', ''))
        require(mount['Type'] == 'bind' and mount['Destination'] in ('/var/www/app', '/app') and source.resolve() == source and (source == root or root in source.parents), 'Unsupported additional database mount')
    require(environment(db).get('MYSQL_DATABASE') and environment(db).get('MYSQL_ROOT_PASSWORD'), 'Source database credentials are unavailable to the backup tool')
    env = environment(web)
    allowed = ('WEB_', 'PHP_', 'FPM_', 'SERVICE_', 'LOG_', 'APPLICATION_')
    webenv = {key: value for key, value in env.items() if key.startswith(allowed)}
    require(not any('PASSWORD' in key or 'SECRET' in key or 'TOKEN' in key for key in webenv), 'Custom application credentials require a dedicated adapter')
    mounts = []
    wordpress = None
    document_value = env.get('WEB_DOCUMENT_ROOT', '/var/www/html').strip()
    if len(document_value) >= 2 and document_value[0] == document_value[-1] and document_value[0] in ('\"', "'"):
        document_value = document_value[1:-1]
    document = Path(document_value)
    require(re.fullmatch(r'/[a-zA-Z0-9_./-]+', str(document)) is not None and '..' not in document.parts, 'Unsupported document root')
    for mount in web.get('Mounts', []):
        require(mount['Type'] == 'bind', 'Additional web volumes require a dedicated adapter')
        source = Path(mount['Source'])
        require(source.resolve() == source and (source == root or root in source.parents), 'A source mount escapes the project')
        target = Path(mount['Destination'])
        require(target.is_absolute() and '..' not in target.parts and str(target) != '/' and not any(char in str(target) or char in str(source) for char in (':', '\n', '\r')) and not (target == Path('/opt/i7y') or Path('/opt/i7y') in target.parents or target in Path('/opt/i7y').parents), 'Unsupported mount target')
        relative = source.relative_to(root)
        mounts.append({'relative': str(relative), 'target': str(target), 'read_only': not mount.get('RW', True)})
        if document == target or target in document.parents:
            local = source / document.relative_to(target)
            if (local / 'wp-load.php').is_file() and (local / 'wp-config.php').is_file():
                wordpress = str(document)
    require(wordpress and mounts, 'A standard WordPress document root could not be confirmed')
    identity = 'i7y-' + destination_domain[:28].replace('.', '-') + '-' + digest(destination_domain)[:10]
    return {'source_domain': source_domain, 'destination_domain': destination_domain,
            'source_root': str(root), 'destination_root': str(root.parent / destination_domain),
            'database_id': db['Id'], 'web_id': web['Id'], 'database_image': db['Image'], 'web_image': web['Image'],
            'database_name': identity + '-db', 'web_name': identity + '-web', 'volume_name': identity + '-data',
            'network_name': identity + '-internal', 'mounts': mounts, 'wordpress_root': wordpress, 'web_environment': webenv, 'database_service': db['Config'].get('Labels', {}).get('com.docker.compose.service', 'database'), 'web_service': web['Config'].get('Labels', {}).get('com.docker.compose.service', 'web')}


def inspect(request, include_files=True):
    require(domain(request['source_domain']) and domain(request['destination_domain']), 'Invalid project domain')
    root = source_root(request['source_path'], request['source_domain'])
    ids = command(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project.working_dir=' + str(root / 'app')]).split()
    if ids:
        require(len(ids) == 2, 'Expected two Compose containers for the selected project directory')
        containers = json.loads(command(['docker', 'inspect'] + ids))
    else:
        all_ids = command(['docker', 'ps', '-aq']).split()
        require(all_ids, 'No source containers were found')
        candidates = json.loads(command(['docker', 'inspect'] + all_ids))
        anchored = [c for c in candidates if any(m.get('Type') == 'bind' and m.get('Source') == str(root / 'app') for m in c.get('Mounts', []))]
        groups = {c['Config'].get('Labels', {}).get('com.docker.compose.project') for c in anchored}
        require(len(groups) == 1 and None not in groups and '' not in groups, 'A unique Compose project could not be confirmed from the source mounts')
        group = next(iter(groups))
        containers = [c for c in candidates if c['Config'].get('Labels', {}).get('com.docker.compose.project') == group]
        require(len(containers) == 2 and {c['Id'] for c in anchored}.issubset({c['Id'] for c in containers}), 'Expected two containers in the confirmed legacy Compose project')
    value = model(root, request['source_domain'], request['destination_domain'], containers)
    for container in containers:
        defaults = json.loads(command(['docker', 'image', 'inspect', container['Image']]))[0]['Config']
        require(container['Config'].get('Entrypoint') == defaults.get('Entrypoint') and container['Config'].get('Cmd') == defaults.get('Cmd'), 'Custom startup commands require a dedicated adapter')
    value['files'] = manifest(root) if include_files else []
    return value


def public_plan(value):
    return {key: value[key] for key in ('source_domain', 'destination_domain', 'source_root', 'destination_root',
            'database_name', 'web_name', 'volume_name', 'network_name', 'wordpress_root', 'database_image', 'web_image')}


def state_directory(request):
    require(re.fullmatch(r'[a-f0-9]{32}', request['operation_id']) is not None, 'Invalid operation identifier')
    root = Path('/var/tmp/i7y-project-copy')
    if not root.exists():
        root.mkdir(mode=0o700)
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700, 'Unsafe operation storage')
    return root.resolve() / request['operation_id']


def check_space(value, state_root):
    script = 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --no-defaults --protocol=socket --user=root --batch --skip-column-names --database="$MYSQL_DATABASE" --execute="SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"'
    size = command(['docker', 'exec', value['database_id'], '/bin/sh', '-c', script]).strip()
    require(size.isdigit(), 'Unable to estimate database storage')
    database_bytes = int(size)
    file_bytes = sum(entry[4] for entry in value['files'] if entry[6] is not None)
    destination_parent = Path(value['destination_root']).parent
    reserve_bytes = 2 * 1024 ** 3
    if os.stat(str(destination_parent)).st_dev == os.stat(str(state_root)).st_dev:
        require(shutil.disk_usage(str(destination_parent)).free >= file_bytes + 6 * database_bytes + reserve_bytes, 'Insufficient disk space for an independent project and database copy')
    else:
        require(shutil.disk_usage(str(destination_parent)).free >= file_bytes + 3 * database_bytes + reserve_bytes and shutil.disk_usage(str(state_root)).free >= 3 * database_bytes + reserve_bytes, 'Insufficient disk space for an independent project and database copy')


def preview(request):
    value = inspect(request)
    require(not Path(value['destination_root']).exists(), 'Destination directory already exists')
    state = state_directory(request)
    check_space(value, state.parent)
    state.mkdir(mode=0o700)
    plan = {'created_at': int(time.time()), 'request': request, 'source': value, 'fingerprint': digest(value)}
    private_json(state / 'plan.json', plan)
    result = public_plan(value)
    result.update({'fingerprint': plan['fingerprint'], 'expires_at': plan['created_at'] + 600, 'operation_id': request['operation_id'], 'state_path': str(state), 'file_count': len(value['files'])})
    return result


def load_plan(request):
    state = state_directory(request)
    require(state.is_dir() and not state.is_symlink(), 'Operation preview unavailable')
    plan = json.loads((state / 'plan.json').read_text())
    require(plan['request'] == {key: request[key] for key in plan['request']}, 'Operation parameters changed')
    require(request.get('fingerprint') == plan['fingerprint'], 'Preview approval does not match')
    return state, plan


def reserve(request):
    state, plan = load_plan(request)
    if (state / 'completed.json').is_file():
        require(not (state / 'attempt.active').exists(), 'A previous copy attempt requires reconciliation before retry')
        return reserve_started(request, state, plan)
    attempt = request.get('attempt_id', '')
    require(re.fullmatch(r'[a-f0-9]{32}', attempt) is not None, 'Invalid copy attempt identifier')
    active = state / 'attempt.active'
    try:
        private_json(active, {'attempt_id': attempt})
    except FileExistsError:
        raise CopyError('A previous copy attempt requires reconciliation before retry')
    try:
        return reserve_started(request, state, plan)
    except Exception:
        active.unlink()
        raise


def reserve_started(request, state, plan):
    if (state / 'completed.json').is_file():
        completed = json.loads((state / 'completed.json').read_text())
        verified = json.loads((state / 'verified.json').read_text())
        require(completed.get('review_required') is False and verified.get('source') == plan['source']['source_domain'] and verified.get('destination') == plan['source']['destination_domain'], 'Completed operation state is invalid')
        lock = state.parent / 'copy.lock'
        if lock.exists() and (lock / 'owner.json').is_file() and json.loads((lock / 'owner.json').read_text()).get('operation_id') == request['operation_id']:
            (lock / 'owner.json').unlink()
            lock.rmdir()
        return dict(public_plan(plan['source']), review_required=False, operation_id=request['operation_id'], completed=True)
    require((state / 'started.json').exists() or int(time.time()) <= plan['created_at'] + 600, 'Preview expired; inspect the project again')
    require({k: v for k, v in inspect(plan['request'], include_files=False).items() if k != 'files'} == {k: v for k, v in plan['source'].items() if k != 'files'}, 'Source container configuration changed')
    lock = state.parent / 'copy.lock'
    if (state / 'started.json').exists():
        require((lock / 'owner.json').is_file() and json.loads((lock / 'owner.json').read_text()).get('operation_id') == request['operation_id'], 'Operation lock owner mismatch')
        return dict(public_plan(plan['source']), state_path=str(state), database_id=plan['source']['database_id'])
    require(not Path(plan['source']['destination_root']).exists(), 'Destination directory already exists')
    check_space(plan['source'], state.parent)
    created_lock = False
    if lock.exists():
        require((lock / 'owner.json').is_file() and json.loads((lock / 'owner.json').read_text()).get('operation_id') == request['operation_id'], 'Another project copy requires completion or reconciliation')
    else:
        lock.mkdir(mode=0o700)
        created_lock = True
        private_json(lock / 'owner.json', {'operation_id': request['operation_id']})
    try:
        for kind, key in [('container', 'database_name'), ('container', 'web_name'), ('volume', 'volume_name'), ('network', 'network_name')]:
            values = command(['docker', kind, 'ls'] + (['-a'] if kind == 'container' else []) + ['--format', '{{.Name}}' if kind == 'volume' else '{{.Names}}' if kind == 'container' else '{{.Name}}']).splitlines()
            require(plan['source'][key] not in values, 'Destination Docker resource already exists')
    except CopyError:
        if created_lock:
            (lock / 'owner.json').unlink()
            lock.rmdir()
        raise
    private_json(state / 'started.json', {'started_at': int(time.time())})
    return dict(public_plan(plan['source']), state_path=str(state), database_id=plan['source']['database_id'])


def available_subnet(reserved=()):
    ids = command(['docker', 'network', 'ls', '-q']).split()
    networks = json.loads(command(['docker', 'network', 'inspect'] + ids)) if ids else []
    used = [ipaddress.ip_network(item['Subnet']) for network in networks for item in (network.get('IPAM', {}).get('Config') or []) if item.get('Subnet')]
    for line in (command(['ip', '-4', 'route']).splitlines() if sys.platform.startswith('linux') else []):
        address = line.split()[0]
        if address != 'default':
            used.append(ipaddress.ip_network(address, strict=False))
    used.extend(ipaddress.ip_network(subnet) for subnet in reserved)
    for candidate in ipaddress.ip_network('10.240.0.0/12').subnets(new_prefix=28):
        if not any(candidate.overlaps(other) for other in used if other.version == 4):
            return str(candidate)
    raise CopyError('No unused private network range is available')


def isolated_compose(compose, database_service, web_service, network_name, subnet):
    isolated = copy.deepcopy(compose)
    require(set(isolated.get('services', {})) == {database_service, web_service}, 'Copy requires exactly two services')
    for service in isolated['services'].values():
        require(not service.get('privileged') and not service.get('cap_add') and not service.get('devices'), 'Privileged source containers require a dedicated adapter')
        for key in ('network_mode', 'pid', 'ipc', 'uts', 'userns_mode', 'security_opt', 'device_cgroup_rules', 'runtime', 'sysctls', 'volumes_from', 'links', 'extra_hosts', 'dns', 'dns_opt', 'dns_search', 'use_api_socket', 'configs', 'secrets', 'build'):
            require(not service.get(key), 'Custom container isolation settings require a dedicated adapter')
        dropped = service.get('cap_drop') or []
        require(isinstance(dropped, list) and all(isinstance(item, str) for item in dropped), 'Unsupported capability configuration')
        service['cap_drop'] = list(dict.fromkeys(dropped + ['NET_RAW', 'NET_ADMIN']))
        service['security_opt'] = ['no-new-privileges:true']
        service.pop('ports', None)
        service.pop('depends_on', None)
        service.pop('deploy', None)
        service['restart'] = 'no'
        service['networks'] = ['i7y_review']
    isolated['networks'] = {'i7y_review': {'name': network_name, 'driver': 'bridge', 'internal': True,
        'enable_ipv6': False, 'driver_opts': {'com.docker.network.bridge.gateway_mode_ipv4': 'isolated'},
        'ipam': {'config': [{'subnet': subnet}]}}}
    return isolated


def require_isolated_network(network, containers, expected_name):
    require(network.get('Name') == expected_name and network.get('Driver') == 'bridge' and network.get('Internal') is True,
            'The review network is not internal')
    require(not network.get('EnableIPv6') and network.get('Options', {}).get('com.docker.network.bridge.gateway_mode_ipv4') == 'isolated',
            'The review network does not provide an isolated gateway')
    configs = network.get('IPAM', {}).get('Config') or []
    require(configs and all(not config.get('Gateway') for config in configs), 'The review network has a host gateway')
    expected_ids = set()
    for container in containers:
        host = container.get('HostConfig') or {}
        require(not host.get('Privileged') and not host.get('CapAdd') and not host.get('Devices') and not host.get('PortBindings') and not host.get('PublishAllPorts'),
                'A review container has unsafe privileges or published ports')
        dropped = {str(item).upper().replace('CAP_', '', 1) if str(item).upper().startswith('CAP_') else str(item).upper() for item in (host.get('CapDrop') or [])}
        require({'NET_RAW', 'NET_ADMIN'}.issubset(dropped) or 'ALL' in dropped, 'A review container can alter network traffic')
        require('no-new-privileges:true' in (host.get('SecurityOpt') or []), 'A review container can gain privileges')
        settings = container.get('NetworkSettings') or {}
        require(not any((settings.get('Ports') or {}).values()), 'A review container has published ports')
        require(set(settings.get('Networks') or {}) == {expected_name},
                'A review container is connected to an unexpected network')
        expected_ids.add(container['Id'])
    require(set((network.get('Containers') or {}).keys()) == expected_ids, 'The review network has unexpected containers')


def prepare(request):
    state, plan = load_plan(request)
    if (state / 'prepared.json').exists():
        return json.loads((state / 'prepared.json').read_text())
    require((state / 'started.json').exists(), 'Copy has not started')
    value = plan['source']
    root = Path(value['source_root'])
    destination = Path(value['destination_root'])
    require(manifest(root) == value['files'], 'Source files changed since preview')
    compose = json.loads((state / 'source-compose.json').read_text())
    volume_names = command(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines()
    internal_networks = [key for key, definition in compose.get('networks', {}).items() if not (definition or {}).get('external')]
    network_names = command(['docker', 'network', 'ls', '--format', '{{.Name}}']).splitlines()
    review_network = value['network_name'] + '-review'
    require(review_network not in network_names, 'Destination Docker resource already exists')
    for key in internal_networks:
        name = value['network_name'] + '-' + digest(replace_domain(key, value['source_domain'], value['destination_domain']))[:12]
        require(name not in network_names, 'Destination Docker resource already exists')
    for key, definition in compose.get('volumes', {}).items():
        definition = definition or {}
        require(isinstance(definition, dict) and not definition.get('external') and not definition.get('driver_opts') and definition.get('driver', 'local') == 'local', 'Custom or external source volumes require a dedicated adapter')
        key = replace_domain(key, value['source_domain'], value['destination_domain'])
        require(value['volume_name'] + '-' + key not in volume_names, 'Destination Docker resource already exists')
    require({k: v for k, v in inspect(plan['request'], include_files=False).items() if k != 'files'} == {k: v for k, v in value.items() if k != 'files'}, 'Source container configuration changed')
    require(not (state / 'backup.pending').exists(), 'Backup outcome requires reconciliation before retry')
    backup = state / 'database.sql'
    require(backup.is_file() and backup.stat().st_size > 0, 'Verified database backup required before copying files')
    backup_hash = hashlib.sha256()
    with backup.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            backup_hash.update(chunk)
        os.fsync(stream.fileno())
    backup_sha256 = backup_hash.hexdigest()
    receipt = state / 'database.sha256'
    require(receipt.is_file() and not receipt.is_symlink() and receipt.read_text().strip() == backup_sha256, 'Database backup checksum does not match the original backup')
    replace_json(state / 'backup.json', {'sha256': backup_sha256, 'bytes': backup.stat().st_size})
    owner = root.stat()
    require(owner.st_uid != 0, 'A regular project owner is required')
    destination.mkdir(mode=stat.S_IMODE(owner.st_mode), exist_ok=True)
    os.chown(str(destination), owner.st_uid, owner.st_gid)
    command(['cp', '-a', str(root) + '/.', str(destination)], timeout=900)
    manifest(destination)
    for base, directories, files in os.walk(str(destination)):
        for name in directories + files:
            os.chown(str(Path(base) / name), owner.st_uid, owner.st_gid)
    database = 'i7y_' + digest(value['destination_domain'])[:16]
    credentials = {'MYSQL_DATABASE': database, 'MYSQL_USER': database, 'MYSQL_PASSWORD': secrets.token_hex(32)}
    dbcredentials = dict(credentials, MYSQL_ROOT_PASSWORD=secrets.token_hex(32))
    tools = str(state / 'tools')
    allocated_subnets = []
    services = compose['services']
    db_service = replace_domain(value['database_service'], value['source_domain'], value['destination_domain'])
    web_service = replace_domain(value['web_service'], value['source_domain'], value['destination_domain'])
    require(set(services) == {value['database_service'], value['web_service']}, 'Compose must contain the two selected services')
    compose = json.loads(replace_domain(json.dumps(compose), value['source_domain'], value['destination_domain']))
    services = compose['services']
    db = services[db_service]
    web = services[web_service]
    db['image'] = value['database_image']
    web['image'] = value['web_image']
    db['container_name'] = '${MYSQL_HOST}'
    web['container_name'] = '${WEB_HOST}'
    for service in (db, web):
        environment_values = service.get('environment', {})
        is_list = isinstance(environment_values, list)
        if is_list:
            environment_values = dict(entry.split('=', 1) if '=' in entry else (entry, None) for entry in environment_values)
        for key in dbcredentials:
            if key in credentials or key in environment_values or service is db:
                environment_values[key] = '${' + key + '}'
        service['environment'] = [key + '=' + item if item is not None else key for key, item in environment_values.items()] if is_list else environment_values
    for key, definition in compose.get('volumes', {}).items():
        definition = definition or {}
        require(not definition.get('external'), 'External source volumes require explicit mapping')
        definition['name'] = value['volume_name'] + '-' + key
        compose['volumes'][key] = definition
    for key, definition in compose.get('networks', {}).items():
        definition = definition or {}
        if definition.get('external'):
            continue
        definition['name'] = value['network_name'] + '-' + digest(key)[:12]
        subnet = available_subnet(allocated_subnets)
        allocated_subnets.append(subnet)
        definition.setdefault('ipam', {})['config'] = [{'subnet': subnet}]
        compose['networks'][key] = definition
    compose['version'] = '3.5'
    web.setdefault('volumes', []).extend([tools + ':/opt/i7y/tools:ro', str(state / 'wordpress') + ':/opt/i7y/state'])
    (state / 'wordpress').mkdir(mode=0o700, exist_ok=True)
    compose_path = destination / 'app' / 'docker-compose.yml'
    require(compose_path.is_file() and not compose_path.is_symlink(), 'Standard Compose file required')
    shutil.copy2(str(compose_path), str(state / 'source-compose.yml'))
    env_path = destination / 'app' / '.env'
    existing = replace_domain(env_path.read_text(), value['source_domain'], value['destination_domain']).splitlines() if env_path.exists() else []
    values = dict(dbcredentials, MYSQL_HOST=value['database_name'], WEB_HOST=value['web_name'], COMPOSE_PROJECT_NAME='i7y-' + digest(value['destination_domain'])[:16])
    existing = [line for line in existing if line.split('=', 1)[0].strip() not in values]
    env_path.write_text('\n'.join(existing + [key + '=' + item for key, item in values.items()]) + '\n')
    os.chmod(str(env_path), 0o600)
    os.chown(str(env_path), owner.st_uid, owner.st_gid)
    review_subnet = available_subnet(allocated_subnets)
    review_compose = isolated_compose(compose, db_service, web_service, review_network, review_subnet)
    web_mounts = [str(destination / mount['relative']) + ':' + mount['target'] + (':ro' if mount['read_only'] else '') for mount in value['mounts']]
    review_compose['services'][web_service]['volumes'] = web_mounts + [tools + ':/opt/i7y/tools:ro', str(state / 'wordpress') + ':/opt/i7y/state']
    db_mounts = review_compose['services'][db_service].get('volumes', [])
    data_mounts = [mount for mount in db_mounts if isinstance(mount, str) and len(mount.split(':')) in (2, 3) and mount.split(':')[1] == '/var/lib/mysql']
    require(len(data_mounts) == 1 and data_mounts[0].split(':')[0] in review_compose.get('volumes', {}), 'The review database requires one named volume')
    review_compose['services'][db_service]['volumes'] = data_mounts
    replace_json(state / 'publish-compose.json', compose)
    replace_json(state / 'compose.json', review_compose)
    replace_json(compose_path, review_compose)
    result = {'review_network': review_network, 'compose_path': str(compose_path), 'state_path': str(state), 'wordpress_root': value['wordpress_root'], 'database_name': value['database_name'], 'database_service': db_service, 'web_service': web_service, 'backup_sha256': backup_sha256}
    private_json(state / 'prepared.json', result)
    return result


def activate(request):
    state, plan = load_plan(request)
    require((state / 'prepared.json').is_file(), 'Copy is not prepared')
    require((state / 'verified.json').is_file(), 'The isolated copy must pass verification before publication')
    configuration = state / 'compose.json'
    compose = json.loads((state / 'publish-compose.json').read_text())
    web = compose['services'][replace_domain(plan['source']['web_service'], plan['source']['source_domain'], plan['source']['destination_domain'])]
    web['volumes'] = [mount for mount in web['volumes'] if not mount.endswith(':/opt/i7y/tools:ro') and not mount.endswith(':/opt/i7y/state')]
    for path in [configuration, Path(plan['source']['destination_root']) / 'app/docker-compose.yml']:
        temporary = path.with_name(path.name + '.pending')
        private_json(temporary, compose)
        os.replace(str(temporary), str(path))
    replace_json(state / 'activated.json', {'activated_at': int(time.time())})
    return {'compose_path': str(configuration)}


def inspect_review_network(request, require_database, require_web=False):
    state, plan = load_plan(request)
    prepared = json.loads((state / 'prepared.json').read_text())
    name = prepared['review_network']
    networks = json.loads(command(['docker', 'network', 'inspect', name]))
    require(len(networks) == 1, 'Review network not found')
    network = networks[0]
    ids = list((network.get('Containers') or {}).keys())
    containers = json.loads(command(['docker', 'inspect'] + ids)) if ids else []
    allowed_names = {plan['source']['database_name'], plan['source']['web_name']}
    require(all(item.get('Name', '').lstrip('/') in allowed_names for item in containers), 'The review network has unexpected containers')
    expected_images = {plan['source']['database_name']: plan['source']['database_image'], plan['source']['web_name']: plan['source']['web_image']}
    require(all(item.get('Image') == expected_images[item.get('Name', '').lstrip('/')] for item in containers), 'A review container is using an unapproved image')
    if require_database:
        require(any(item.get('Name', '').lstrip('/') == plan['source']['database_name'] for item in containers), 'Review database is not connected')
    if require_web:
        require(any(item.get('Name', '').lstrip('/') == plan['source']['web_name'] for item in containers), 'Review web service is not connected')
    require_isolated_network(network, containers, name)
    return {'verified': True}


def verify_network_prestart(request):
    return inspect_review_network(request, False)


def verify_isolation(request, require_web=False):
    return inspect_review_network(request, True, require_web)


def release_backup_attempt(request):
    state, plan = load_plan(request)
    attempt = request.get('attempt_id', '')
    require(re.fullmatch(r'[a-f0-9]{32}', attempt) is not None, 'Invalid copy attempt identifier')
    active = state / 'attempt.active'
    require(active.is_file() and json.loads(active.read_text()).get('attempt_id') == attempt, 'Copy attempt owner mismatch')
    require(not (state / 'backup.pending').exists() and not (state / 'database.sql').exists(), 'Backup outcome requires reconciliation before retry')
    log = state / 'backup.stderr'
    require(log.is_file() and 'I7Y_BACKUP_CLEAN' in log.read_text().splitlines(), 'Backup cleanup was not confirmed')
    exec_ids = json.loads(command(['docker', 'inspect', '--format', '{{json .ExecIDs}}', plan['source']['database_id']]))
    require(not exec_ids, 'The source database still has active exec sessions')
    active.unlink()
    return {'released': True}


def release_health_attempt(request):
    state, _ = load_plan(request)
    attempt = request.get('attempt_id', '')
    require(re.fullmatch(r'[a-f0-9]{32}', attempt) is not None, 'Invalid copy attempt identifier')
    active = state / 'attempt.active'
    require(active.is_file() and json.loads(active.read_text()).get('attempt_id') == attempt, 'Copy attempt owner mismatch')
    require((state / 'restored').is_file() and (state / 'finalized').is_file() and not (state / 'activated.json').exists() and not (state / 'backup.pending').exists(), 'Copy attempt requires reconciliation')
    active.unlink()
    return {'released': True}


def cleanup_isolation(request):
    state, _ = load_plan(request)
    require((state / 'activated.json').is_file(), 'The isolated copy has not been activated')
    name = json.loads((state / 'prepared.json').read_text())['review_network']
    names = command(['docker', 'network', 'ls', '--format', '{{.Name}}']).splitlines()
    if name not in names:
        return {'removed': False}
    networks = json.loads(command(['docker', 'network', 'inspect', name]))
    require(len(networks) == 1, 'Review network not found')
    require_isolated_network(networks[0], [], name)
    command(['docker', 'network', 'rm', name])
    return {'removed': True}


def verify(request):
    state, plan = load_plan(request)
    value = plan['source']
    verify_isolation(request, True)
    require((state / 'restored').is_file() and (state / 'finalized').is_file(), 'Database restoration and domain configuration must finish before verification')
    receipt_path = state / 'wordpress/domain-contract.json'
    require(receipt_path.is_file(), 'The verified WordPress domain contract is missing')
    receipt = json.loads(receipt_path.read_text())
    require(receipt.get('verified') is True and receipt.get('source') == value['source_domain'] and receipt.get('destination') == value['destination_domain'], 'The copied site domain has not been verified')
    require(not (state / 'wordpress/temporary-columns.json').exists(), 'Temporary database identifiers have not been removed')
    for name in [value['database_name'], value['web_name']]:
        require(command(['docker', 'inspect', '--format', '{{.State.Running}}', name]).strip() == 'true', 'A destination container is not running')
    database_check = 'export MYSQL_PWD="$MYSQL_PASSWORD"; exec mysql --no-defaults --protocol=tcp --host=127.0.0.1 --user="$MYSQL_USER" --database="$MYSQL_DATABASE" --batch --skip-column-names --execute="SELECT 1"'
    require(command(['docker', 'exec', value['database_name'], '/bin/sh', '-c', database_check]).strip() == '1', 'The copied database is not accessible with its application credentials')
    response = command(['docker', 'exec', value['web_name'], 'curl', '--silent', '--show-error', '--max-time', '10', '-H', 'Host: ' + value['destination_domain'], '-H', 'X-Forwarded-Proto: https', '-D', '-', '-o', '/dev/null', '--write-out', '\nI7Y_HTTP_CODE:%{http_code}', 'http://127.0.0.1/'], timeout=15)
    status = re.search(r'I7Y_HTTP_CODE:(\d{3})', response)
    require(status is not None and 200 <= int(status.group(1)) < 400, 'The copied site did not return a successful HTTP response')
    for location in re.findall(r'^Location:\s*(.*?)\s*$', response, re.I | re.M):
        host = urlsplit(location).hostname
        require(host not in (value['source_domain'], 'www.' + value['source_domain']), 'The copied site redirects to the original domain')
    result = {'http_status': int(status.group(1)), 'verified_at': int(time.time()), 'source': value['source_domain'], 'destination': value['destination_domain']}
    replace_json(state / 'verified.json', result)
    return result


def finish(request):
    state, plan = load_plan(request)
    require((state / 'verified.json').is_file(), 'The copied site must pass HTTP and database verification before completion')
    verified = json.loads((state / 'verified.json').read_text())
    require(verified.get('source') == plan['source']['source_domain'] and verified.get('destination') == plan['source']['destination_domain'], 'The final verification does not match this copy')
    source = Path(plan['source']['source_root'])
    destination = Path(plan['source']['destination_root'])
    owner = source.stat()
    require(owner.st_uid != 0, 'A regular project owner is required')
    require(destination.resolve() == destination and not destination.is_symlink(), 'Unsafe destination directory')
    for base, directories, files in os.walk(str(destination), followlinks=False):
        for name in directories + files:
            path = Path(base) / name
            require(not path.is_symlink(), 'Unexpected symbolic link in copied files')
            os.chown(str(path), owner.st_uid, owner.st_gid)
    os.chown(str(destination), owner.st_uid, owner.st_gid)
    os.chmod(str(destination), stat.S_IMODE(owner.st_mode))
    lock = state.parent / 'copy.lock'
    active = state / 'attempt.active'
    require(lock.is_dir() and (lock / 'owner.json').is_file() and json.loads((lock / 'owner.json').read_text()).get('operation_id') == request['operation_id'], 'Operation lock owner mismatch')
    require(active.is_file() and json.loads(active.read_text()).get('attempt_id') == request.get('attempt_id'), 'Copy attempt owner mismatch')
    replace_json(state / 'completed.json', {'completed_at': int(time.time()), 'review_required': False})
    (lock / 'owner.json').unlink()
    lock.rmdir()
    active.unlink()
    return dict(public_plan(plan['source']), review_required=False, operation_id=request['operation_id'])


def main():
    try:
        require(len(sys.argv) == 3 and sys.argv[1] in ('preview', 'reserve', 'prepare', 'activate', 'verify_network_prestart', 'verify_isolation', 'release_backup_attempt', 'release_health_attempt', 'cleanup_isolation', 'verify', 'finish'), 'Unsupported project copy phase')
        request = json.loads(Path(sys.argv[2]).read_text())
        result = globals()[sys.argv[1]](request)
        print(json.dumps(result, sort_keys=True))
    except (CopyError, OSError, ValueError, KeyError, StopIteration) as error:
        print(json.dumps({'error': str(error) if isinstance(error, CopyError) else 'Project copy failed; inspect private operation state'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
