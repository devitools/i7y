import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


DOCKER_FIXTURE = '''#!/usr/local/bin/python
import json, os, sys
from pathlib import Path
root = Path(os.environ["I7Y_DOCKER_FIXTURE"])
state = json.loads((root / "state.json").read_text())
args = sys.argv[1:]
if args == ["ps", "--all", "--no-trunc", "--format", '{"ID":{{json .ID}},"Names":{{json .Names}},"Image":{{json .Image}},"State":{{json .State}},"Status":{{json .Status}},"Ports":{{json .Ports}}}']:
    print(json.dumps({"ID": "fixture", "Names": "example-app", "State": state["state"], "Image": "example/app:1", "Status": "Up", "Ports": ""}))
elif len(args) == 6 and args[:4] == ["inspect", "--type", "container", "--format"]:
    expected = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"state":{{json .State.Status}}}'
    if args[4] != expected or args[5] != "a" * 64 or state.get("missing"):
        sys.exit(23)
    print(json.dumps({"id": "a" * 64, "name": "/example-app", "image": "example/app:1", "state": state["state"]}))
elif args in [["start", "a" * 64], ["stop", "--time", "30", "a" * 64], ["restart", "--time", "30", "a" * 64]]:
    with (root / "mutations.jsonl").open("a") as output:
        output.write(json.dumps(args) + "\\n")
    if not state.get("freeze"):
        state["state"] = "exited" if args[0] == "stop" else "running"
        (root / "state.json").write_text(json.dumps(state))
    print("a" * 64)
else:
    sys.exit(24)
'''


class Recipes(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="i7y-recipes-")
        self.root = Path(self.temporary.name)
        self.binary = Path("/usr/local/bin/docker")
        self.binary.write_text(DOCKER_FIXTURE)
        self.binary.chmod(0o700)
        self.state("running")

    def tearDown(self):
        self.binary.unlink()
        self.temporary.cleanup()

    def state(self, value, **extra):
        (self.root / "state.json").write_text(json.dumps({"state": value, **extra}))

    def mutations(self):
        path = self.root / "mutations.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def run_recipe(self, name, variables=None, success=True):
        result = subprocess.run(
            ["ansible-playbook", "-i", "localhost,", "-c", "local",
             "-e", "ansible_python_interpreter=/usr/local/bin/python",
             "-e", json.dumps(variables or {}), "/recipes/" + name + ".yml"],
            capture_output=True, text=True, timeout=60,
            env={**os.environ, "I7Y_DOCKER_FIXTURE": str(self.root),
                 "ANSIBLE_NOCOLOR": "1", "ANSIBLE_HOST_KEY_CHECKING": "True"},
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertRegex(result.stdout, r"unreachable=0\s+failed=0")
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result.stdout

    def test_server_summary(self):
        output = self.run_recipe("server-inspect")
        self.assertIn("Linux", output)
        self.assertIn('"uptime_seconds"', output)
        self.assertRegex(output, r"changed=0")

    def test_disk_usage(self):
        output = self.run_recipe("server-disk")
        self.assertIn("Filesystem", output)
        self.assertRegex(output, r"changed=0")

    def test_ansible_ping_records_pong(self):
        destination = self.root / "ping.json"
        self.run_recipe("server-ping", {"i7y_ping_output": str(destination)})
        self.assertEqual(json.loads(destination.read_text()), {"ping": "pong"})
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.mutations(), [])

    def test_container_summary_omits_environment(self):
        output = self.run_recipe("container-list")
        self.assertIn("example-app", output)
        self.assertNotIn("Env", output)
        self.assertRegex(output, r"changed=0")

    def test_preflight_saves_only_selected_metadata(self):
        output = self.root / "preflight.json"
        self.run_recipe("container-preflight", {"i7y_container_id": "a" * 64, "i7y_preflight_output": str(output)})
        data = json.loads(output.read_text())
        self.assertEqual(set(data), {"id", "name", "image", "state"})
        self.assertEqual(data["state"], "running")
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.mutations(), [])

    def test_structured_inspection_evidence_is_persisted_without_command_logs(self):
        for recipe, key in [("server-inspect", "kernel"), ("server-disk", "disks"), ("container-list", "containers")]:
            path = self.root / (recipe + ".json")
            self.run_recipe(recipe, {"i7y_result_output": str(path)})
            value = json.loads(path.read_text())
            self.assertIn(key, value)
            self.assertNotIn("stdout", value)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_lifecycle_operations_use_the_reviewed_immutable_id(self):
        for action, before, after in [("start", "exited", "running"), ("stop", "running", "exited"), ("restart", "running", "running")]:
            self.state(before)
            self.run_recipe("container-" + action, {"i7y_container_id": "a" * 64, "i7y_expected_state": before})
            self.assertEqual(json.loads((self.root / "state.json").read_text())["state"], after)
            self.assertEqual(self.mutations()[-1][0], action)
            self.assertEqual(self.mutations()[-1][-1], "a" * 64)

    def test_idempotent_start_and_stop_do_not_invoke_mutation(self):
        for action, state in [("start", "running"), ("stop", "exited"), ("stop", "created")]:
            self.state(state)
            output = self.run_recipe("container-" + action, {"i7y_container_id": "a" * 64, "i7y_expected_state": state})
            self.assertRegex(output, r"changed=0")
        self.assertEqual(self.mutations(), [])

    def test_drift_missing_targets_and_invalid_ids_prevent_mutation(self):
        self.state("exited")
        self.run_recipe("container-restart", {"i7y_container_id": "a" * 64, "i7y_expected_state": "running"}, success=False)
        self.state("running", missing=True)
        self.run_recipe("container-stop", {"i7y_container_id": "a" * 64, "i7y_expected_state": "running"}, success=False)
        self.run_recipe("container-start", {"i7y_container_id": "--privileged", "i7y_expected_state": "exited"}, success=False)
        self.assertEqual(self.mutations(), [])

    def test_unsuccessful_postcondition_fails_even_with_zero_command_exit(self):
        self.state("exited", freeze=True)
        self.run_recipe("container-start", {"i7y_container_id": "a" * 64, "i7y_expected_state": "exited"}, success=False)
        self.assertEqual(self.mutations()[0][0], "start")
        self.assertEqual(json.loads((self.root / "state.json").read_text())["state"], "exited")


if __name__ == "__main__":
    unittest.main()
