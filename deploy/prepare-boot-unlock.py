#!/usr/bin/env python
from __future__ import print_function, unicode_literals

import argparse
import base64
import hashlib
import io
import json
import os
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import uuid


WRAPPER = '''#!/bin/sh
set -eu
test -f /etc/initrd-release || exit 70
case "${SSH_ORIGINAL_COMMAND:-}" in
status) exec /usr/bin/systemd-tty-ask-password-agent --list ;;
unlock) exec /usr/bin/systemd-tty-ask-password-agent --query ;;
*) exit 64 ;;
esac
'''

MODULE = '''#!/bin/bash
check() { require_binaries /usr/sbin/sshd /usr/bin/systemd-tty-ask-password-agent; }
depends() { echo "network crypt systemd"; }
install() {
    inst_binary /usr/sbin/sshd || return 1
    inst_multiple /usr/bin/systemd-tty-ask-password-agent /bin/sh || return 1
    inst_libdir_file "libnss_files.so.*"
    inst_simple "$moddir/sshd_config" /etc/ssh/sshd_config
    inst_simple "$moddir/host_key" /etc/ssh/i7y_boot_host_key
    inst_simple "$moddir/host_key.pub" /etc/ssh/i7y_boot_host_key.pub
    inst_simple "$moddir/authorized_keys" /root/.ssh/authorized_keys
    inst_simple "$moddir/boot-unlock" /etc/i7y/boot-unlock
    inst_simple "$moddir/network.conf" /etc/cmdline.d/90-i7y-network.conf
    inst_simple "$moddir/i7y-boot-sshd.service" "$systemdsystemunitdir/i7y-boot-sshd.service"
    mkdir -p -m 0700 "$initdir/root/.ssh"
    chmod 0700 "$initdir/root" "$initdir/root/.ssh"
    chmod 0600 "$initdir/root/.ssh/authorized_keys" "$initdir/etc/ssh/i7y_boot_host_key"
    chmod 0700 "$initdir/etc/i7y/boot-unlock"
    grep -q '^sshd:' "$initdir/etc/passwd" || grep '^sshd:' /etc/passwd >> "$initdir/etc/passwd"
    grep -q '^sshd:' "$initdir/etc/group" || grep '^sshd:' /etc/group >> "$initdir/etc/group"
    printf 'root:*:0:0:99999:7:::\nsshd:*:0:0:99999:7:::\n' > "$initdir/etc/shadow"
    chmod 0600 "$initdir/etc/shadow"
    mkdir -p -m 0755 "$initdir/var/empty/sshd" "$initdir/run/sshd"
    mkdir -p "$initdir$systemdsystemunitdir/sysinit.target.wants"
    ln -s ../i7y-boot-sshd.service "$initdir$systemdsystemunitdir/sysinit.target.wants/i7y-boot-sshd.service"
}
'''

UNIT = '''[Unit]
Description=i7y restricted encrypted boot unlock
DefaultDependencies=no
After=dracut-cmdline.service
Before=cryptsetup.target

[Service]
Type=simple
ExecStart=/usr/sbin/sshd -D -e
Restart=on-failure
RestartSec=5s
KillMode=control-group

[Install]
WantedBy=sysinit.target
'''


def read(path):
    with io.open(path, encoding='utf-8') as source:
        return source.read()


def write(path, content, mode=0o600):
    if not isinstance(content, type(u'')):
        content = content.decode('utf-8')
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with io.open(descriptor, 'w', encoding='utf-8') as output:
        output.write(content)


def run(args, log=None):
    process = subprocess.Popen(args, stdout=log or subprocess.PIPE, stderr=log or subprocess.PIPE,
                               env=dict(os.environ, LC_ALL='C', LANG='C'))
    output, unused = process.communicate()
    if process.returncode:
        raise ValueError('Command failed: {0}; inspect the private build log'.format(args[0]))
    return (output or b'').decode('utf-8', 'replace')


def ipv4(value):
    try:
        if socket.inet_ntop(socket.AF_INET, socket.inet_pton(socket.AF_INET, value)) != value:
            raise ValueError()
    except (ValueError, socket.error):
        raise ValueError('An explicit IPv4 address is required')
    return value


def validate(args):
    ipv4(args.address)
    if not re.match(r'^[a-zA-Z0-9_.-]{1,15}$', args.interface):
        raise ValueError('Invalid network interface')
    if str(uuid.UUID(args.luks_uuid)) != args.luks_uuid:
        raise ValueError('Use the full lowercase LUKS UUID')
    if not 1024 <= args.port <= 65535:
        raise ValueError('Use an unprivileged dedicated boot port')
    for source in args.allow_from:
        parts = source.split('/')
        ipv4(parts[0])
        if len(parts) > 2 or (len(parts) == 2 and not re.match(r'^(?:[1-9]|[12][0-9]|3[0-2])$', parts[1])):
            raise ValueError('Invalid allowed source address or prefix')
    key = read(args.authorized_key).strip().split()
    if len(key) < 2 or key[0] not in ('ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256'):
        raise ValueError('Provide one bare SSH public key, without authorized_keys options')
    if not re.match(r'^[A-Za-z0-9+/]+={0,2}$', key[1]) or '\n' in read(args.authorized_key).strip():
        raise ValueError('Invalid SSH public key')
    wire = base64.b64decode(key[1])
    size = struct.unpack(b'>I', wire[:4])[0]
    if wire[4:4 + size].decode('ascii') != key[0]:
        raise ValueError('SSH public key type does not match its contents')
    return ' '.join(key[:2])


def digest(path):
    result = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def snapshot():
    paths = ['/boot', '/usr/lib/dracut', '/etc/dracut.conf', '/etc/dracut.conf.d',
             '/etc/default/grub', '/etc/grub.d', '/etc/crypttab', '/etc/ssh']
    result = {}
    for path in paths:
        entries = [path]
        if os.path.isdir(path) and not os.path.islink(path):
            entries += [os.path.join(root, name) for root, dirs, files in os.walk(path)
                        for name in dirs + files]
        for entry in entries:
            if os.path.islink(entry):
                result[entry] = {'link': os.readlink(entry)}
            elif os.path.isfile(entry):
                info = os.stat(entry)
                result[entry] = {'sha256': digest(entry), 'mode': stat.S_IMODE(info.st_mode),
                                 'uid': info.st_uid, 'gid': info.st_gid}
            elif not os.path.exists(entry):
                result[entry] = None
    result['packages'] = sorted(run(['rpm', '-qa']).splitlines())
    return result


def preflight(args):
    if os.geteuid() != 0:
        raise ValueError('Run as root; inspection needs to read the original boot files')
    release = read('/etc/os-release')
    if not re.search(r'^ID="?(?:centos|rhel)"?$', release, re.M) or not re.search(r'^VERSION_ID="?7(?:\.|"|$)', release, re.M):
        raise ValueError('This preparation script is validated for CentOS/RHEL 7 only')
    kernel = os.uname()[2]
    if args.expected_kernel and args.expected_kernel != kernel:
        raise ValueError('Running kernel differs from the expected kernel')
    if args.luks_uuid not in read('/proc/cmdline').lower():
        raise ValueError('The expected LUKS UUID is absent from the running kernel command line')
    crypttab = [line.split() for line in read('/etc/crypttab').splitlines()
                if line.strip() and not line.lstrip().startswith('#')]
    if not any(args.luks_uuid in ' '.join(row).lower() for row in crypttab):
        raise ValueError('The expected LUKS UUID is absent from crypttab')
    if any(len(row) > 2 and row[2] not in ('none', '-') for row in crypttab):
        raise ValueError('Embedded disk key files require a separate review')
    if read('/proc/sys/crypto/fips_enabled').strip() != '0':
        raise ValueError('FIPS requires a separately reviewed host key configuration')
    config = read('/etc/sysconfig/network-scripts/ifcfg-' + args.interface)
    if not re.search(r'^BOOTPROTO=[\'\"]?dhcp[\'\"]?\s*$', config, re.M | re.I):
        raise ValueError('Only an already configured DHCP interface is supported')
    addresses = run(['ip', '-4', '-o', 'addr', 'show', 'dev', args.interface])
    if args.address not in re.findall(r'inet ([0-9.]+)/', addresses):
        raise ValueError('The expected address is not assigned to this interface')
    mac = read('/sys/class/net/' + args.interface + '/address').strip()
    driver = os.path.basename(os.path.realpath('/sys/class/net/' + args.interface + '/device/driver/module'))
    if not re.match(r'^[a-zA-Z0-9_]+$', driver) or not re.match(r'^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$', mac):
        raise ValueError('Cannot identify the interface hardware and kernel driver')
    image = '/boot/initramfs-' + kernel + '.img'
    if not os.path.isfile(image):
        raise ValueError('The original image for the running kernel is missing')
    if os.path.exists('/usr/lib/dracut/modules.d/46i7yunlock'):
        raise ValueError('An existing unlock module requires reconciliation')
    for binary in ('dracut', 'lsinitrd', 'ssh-keygen', 'timeout', 'nice', 'ionice'):
        if not any(os.access(os.path.join(path, binary), os.X_OK) for path in os.environ['PATH'].split(':')):
            raise ValueError('Required installed tool is missing: ' + binary)
    free = os.statvfs('/var/tmp')
    if free.f_bavail * free.f_frsize < 768 * 1024 * 1024:
        raise ValueError('At least 768 MiB of temporary disk space is required')
    memory = re.search(r'^MemAvailable:\s+(\d+) kB$', read('/proc/meminfo'), re.M)
    if not memory or int(memory.group(1)) < 256 * 1024:
        raise ValueError('At least 256 MiB of available memory is required')
    run(['ssh-keygen', '-l', '-f', args.authorized_key])
    return {'kernel': kernel, 'original_image': image, 'driver': driver, 'mac': mac}


def ssh_config(args):
    return '''Port {port}
AddressFamily inet
ListenAddress {address}
HostKey /etc/ssh/i7y_boot_host_key
PermitRootLogin prohibit-password
AuthorizedKeysFile /root/.ssh/authorized_keys
AuthenticationMethods publickey
PasswordAuthentication no
ChallengeResponseAuthentication no
UsePAM no
AllowUsers root
AllowTcpForwarding no
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitUserRC no
PermitUserEnvironment no
MaxAuthTries 2
MaxSessions 1
LoginGraceTime 30
ClientAliveInterval 30
ClientAliveCountMax 2
ForceCommand /etc/i7y/boot-unlock
'''.format(port=args.port, address=args.address)


def prepare(args, public_key, facts):
    before = snapshot()
    stage = tempfile.mkdtemp(prefix='i7y-boot-', dir='/var/tmp')
    os.chmod(stage, 0o700)
    write(os.path.join(stage, 'before.json'), json.dumps(before, sort_keys=True, indent=2))
    report = {'stage': stage, 'activated': False, 'rebooted': False, 'validated': False,
              'address': args.address, 'luks_uuid': args.luks_uuid, 'boot_port': args.port,
              'allowed_sources': args.allow_from, 'facts': facts}
    try:
        base = os.path.join(stage, 'dracut')
        shutil.copytree('/usr/lib/dracut', base)
        shutil.copy2('/usr/bin/dracut', os.path.join(base, 'dracut'))
        module = os.path.join(base, 'modules.d', '46i7yunlock')
        os.mkdir(module, 0o700)
        sources = ','.join(args.allow_from)
        authorized = 'from="' + sources + '",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc ' + public_key + '\n'
        network = 'rd.neednet=1 ip={0}:dhcp bootdev={0} ifname={0}:{1}\n'.format(args.interface, facts['mac'])
        files = {'module-setup.sh': MODULE, 'boot-unlock': WRAPPER,
                 'sshd_config': ssh_config(args), 'i7y-boot-sshd.service': UNIT,
                 'authorized_keys': authorized, 'network.conf': network}
        for name, content in files.items():
            write(os.path.join(module, name), content, 0o700 if name in ('module-setup.sh', 'boot-unlock') else 0o600)
        run(['bash', '-n', os.path.join(module, 'module-setup.sh')])
        run(['sh', '-n', os.path.join(module, 'boot-unlock')])
        host_key = os.path.join(module, 'host_key')
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'i7y-encrypted-boot', '-f', host_key])
        validation_config = os.path.join(stage, 'sshd-validation.conf')
        write(validation_config, files['sshd_config'].replace('/etc/ssh/i7y_boot_host_key', host_key))
        run(['/usr/sbin/sshd', '-t', '-f', validation_config])
        config = os.path.join(stage, 'dracut.conf')
        write(config, read('/etc/dracut.conf'))
        confdir = os.path.join(stage, 'conf.d')
        shutil.copytree('/etc/dracut.conf.d', confdir)
        temporary = os.path.join(stage, 'tmp')
        os.mkdir(temporary, 0o700)
        image = os.path.join(stage, 'initramfs-' + facts['kernel'] + '-i7y.img')
        with open(os.path.join(stage, 'build.log'), 'wb') as log:
            run(['timeout', '-k', '10', '300', 'nice', '-n', '19', 'ionice', '-c', '3',
                 os.path.join(base, 'dracut'), '--local', '--hostonly', '--conf', config,
                 '--confdir', confdir, '--tmpdir', temporary, '--logfile', os.path.join(stage, 'dracut.log'),
                 '--add', 'i7yunlock network crypt lvm', '--add-drivers', facts['driver'], image, facts['kernel']], log)
        os.chmod(image, 0o600)
        listing = run(['lsinitrd', image])
        for required in ('etc/i7y/boot-unlock', 'usr/sbin/sshd', 'usr/bin/systemd-tty-ask-password-agent',
                         'root/.ssh/authorized_keys', 'etc/shadow', 'etc/ssh/i7y_boot_host_key',
                         'i7y-boot-sshd.service', '90-i7y-network.conf', 'sbin/dhclient', facts['driver'] + '.ko'):
            if required not in listing:
                raise ValueError('Candidate is missing: ' + required)
        for binary in ('/usr/sbin/sshd', '/usr/bin/systemd-tty-ask-password-agent'):
            libraries = re.findall(r'(/[^\s]+\.so[^\s]*)', run(['ldd', binary]))
            if not libraries or any(os.path.basename(library) not in listing for library in libraries):
                raise ValueError('Candidate is missing shared libraries for: ' + binary)
        for path, expected in (('etc/i7y/boot-unlock', WRAPPER), ('etc/ssh/sshd_config', files['sshd_config']),
                               ('root/.ssh/authorized_keys', authorized), ('etc/cmdline.d/90-i7y-network.conf', network)):
            if run(['lsinitrd', '-f', path, image]).strip() != expected.strip():
                raise ValueError('Unexpected candidate content: ' + path)
        if re.search(r'etc/ssh/ssh_host_\S+_key(?:\s|$)', listing):
            raise ValueError('Candidate unexpectedly contains ordinary SSH host keys')
        write(os.path.join(stage, 'image-listing.txt'), listing)
        report.update(validated=True, image=image, image_sha256=digest(image),
                      boot_host_public_key=read(host_key + '.pub').strip())
    finally:
        after = snapshot()
        report['original_files_unchanged'] = before == after
        if before != after:
            report['validated'] = False
        write(os.path.join(stage, 'report.json'), json.dumps(report, sort_keys=True, indent=2))
        print(json.dumps(report, sort_keys=True))
        if before != after:
            raise ValueError('Protected files or package inventory changed; stop and review')
    return report


def main():
    parser = argparse.ArgumentParser(description='Inspect or prepare an isolated CentOS/RHEL 7 boot-unlock image. Never activates it.')
    parser.add_argument('--address', required=True)
    parser.add_argument('--interface', required=True)
    parser.add_argument('--luks-uuid', required=True)
    parser.add_argument('--authorized-key', required=True)
    parser.add_argument('--allow-from', action='append', required=True)
    parser.add_argument('--expected-kernel')
    parser.add_argument('--port', type=int, default=2222)
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    public_key = validate(args)
    facts = preflight(args)
    if args.prepare:
        prepare(args, public_key, facts)
    else:
        print(json.dumps({'checks_passed': True, 'activated': False, 'prepared': False, 'facts': facts}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, IOError, OSError, struct.error) as error:
        print('Preparation stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
