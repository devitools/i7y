# Prepare encrypted boot unlock

`deploy/prepare-boot-unlock.py` prepares an alternative initramfs for the i7y
`status` / `unlock` SSH protocol. The current implementation supports CentOS/RHEL 7
with Dracut, systemd, an encrypted root disk and an existing DHCP interface.
Other distributions and static networking need a separate review before extending
the script. No package installation is performed.

Run it as root on the target server. Copy the script and the operator's **public**
SSH key into a private temporary directory first. The corresponding private key
stays on the operator's computer and must be the identity selected in i7y.
Use the server's verified disk UUID, interface, current kernel, address and the
operator's public source address; never reuse another server's identifiers.

```sh
python prepare-boot-unlock.py \
  --address 192.0.2.10 --interface eth0 \
  --luks-uuid 00000000-0000-4000-8000-000000000001 \
  --expected-kernel 3.10.0-1160.102.1.el7.x86_64 \
  --authorized-key operator.pub --allow-from 198.51.100.2/32
```

Without `--prepare`, this only checks the prerequisites. Add `--prepare` to build
the candidate. Each invocation creates a new root-only `/var/tmp/i7y-boot-*`
directory with the image, private build logs and `report.json`. It generates a
dedicated boot host key and allows only the public client key and source addresses
provided. The endpoint cannot run arbitrary commands or forward connections.
No provider password or disk passphrase is requested or placed in the image.

The script copies the installed Dracut tree, adds its module to that copy and runs
that isolated copy with `--local`. The build has low CPU/I/O priority and a five
minute time limit. Validation checks the SSH configuration, required binaries and
libraries, networking, command restrictions and image contents. Hashes and
permissions of existing boot/SSH/Dracut files and the package inventory must match
before and after. Failed preparation retains its private directory for diagnosis.

Preparation **does not install the candidate, modify GRUB, change the active boot
configuration, restart services or reboot**. `validated: true` means the static
checks passed; it does not prove the server can boot or unlock through it.

Before activation, review `report.json`, the candidate and the recovery route in
the provider console. Keep the original image/default entry and prepare a separate
one-time boot entry during an agreed maintenance window. A reboot can interrupt
the VPN and a faulty candidate may require selecting the original entry in the
console. This script deliberately has no activation/reboot switch.

Only after a successful controlled boot test, record the candidate's verified
public host key, boot port and exact LUKS UUID in the linked credential item and
load the configuration in i7y. The source allowlist must include the actual egress
address of the selected operator or jump host. Revalidate after kernel/network
changes; this preparation does not automatically persist across kernel updates.

```sh
python3 tests/prepare-boot-unlock.test.py
```

References: [RHEL 7 initramfs administration](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/7/html-single/kernel_administration_guide/index),
[Dracut SSH unlock design](https://github.com/gsauthof/dracut-sshd).
