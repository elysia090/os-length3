"""Mechanical ownership audit for browser execution routes."""

import cProfile
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / 'tools'
sys.path.insert(0, str(TOOLS))

from audit_runtime_routes import (  # noqa: E402
    _profile_route, audit_profile, audit_web_runtime,
)


def _profiled_project_work():
    return sum(range(32))


class TestBrowserRuntimeRoutes(unittest.TestCase):
    def fixture(self, files):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        for name, text in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
        return temporary, root

    def test_walks_imports_workers_and_default_module_urls(self):
        temporary, root = self.fixture({
            'app.js': (
                "import {\n  front,\n} from './front.js';\n"
                "export { helper } from './helper.js';\n"
            ),
            'front.js': (
                "new Worker(new URL('./worker.js', import.meta.url));\n"
                "const driver = new URL('./driver.js', import.meta.url);\n"
                "new SharedWorker('./shared.mjs');\n"
                "navigator.serviceWorker.register('./service.js');\n"
            ),
            'worker.js': "import './vm.js';\npyodide.runPython('step()');\n",
            'driver.js': 'WebAssembly.compile(bytes);\n',
            'helper.js': 'export const helper = 1;\n',
            'service.js': 'export const service = true;\n',
            'shared.mjs': 'export const shared = true;\n',
            'vm.js': 'WebAssembly.instantiate(bytes);\n',
        })
        try:
            result = audit_web_runtime(root)
        finally:
            temporary.cleanup()
        self.assertEqual(result['modules'], [
            'app.js', 'driver.js', 'front.js', 'helper.js', 'service.js',
            'shared.mjs', 'vm.js', 'worker.js'])
        self.assertEqual(result['violation_counts'], {
            'direct-guest-wasm': 1,
            'host-language-runtime': 1,
        })
        py = next(row for row in result['violations']
                  if row['owner'] == 'host-language-runtime')
        self.assertEqual(py['route'], ['app.js', 'front.js', 'worker.js'])

    def test_language_is_not_the_boundary(self):
        temporary, root = self.fixture({
            'app.js': "import './python-guest.js';\n",
            'python-guest.js': (
                "import { executeGuestFunction } from './vm.js';\n"
                "export const runPython = (source, regions) => "
                "executeGuestFunction(source, regions, 7);\n"
            ),
            'vm.js': (
                "// Python, runPython, and WebAssembly.compile in comments\n"
                "const label = 'runPython';\n"
                "const instance = WebAssembly.instantiate(bytes);\n"
                "export const executeGuestFunction = (source) => instance;\n"
            ),
        })
        try:
            result = audit_web_runtime(root)
        finally:
            temporary.cleanup()
        self.assertFalse(result['violations'])
        self.assertTrue(result['ownership_boundary']['language_neutral'])

    def test_direct_wasm_control_is_an_escape_even_if_instantiation_is_hidden(self):
        temporary, root = self.fixture({
            'app.js': "import './runner.js';\n",
            'runner.js': 'export const run = (instance) => instance.exports.main();\n',
        })
        try:
            result = audit_web_runtime(root)
        finally:
            temporary.cleanup()
        self.assertEqual(result['violation_counts'], {
            'host-wasm-control': 1,
        })

    def test_host_wasi_and_semantic_filesystem_are_separate_owners(self):
        temporary, root = self.fixture({
            'app.js': "import './compiler.js';\n",
            'compiler.js': (
                'const fs = new MemoryFileSystem(resources);\n'
                'const host = new WasiPreview1({ fs });\n'
                'host.setMemory(memory);\n'
            ),
        })
        try:
            result = audit_web_runtime(root)
        finally:
            temporary.cleanup()
        self.assertEqual(result['violation_counts'], {
            'host-language-memory': 1,
            'host-wasi-runtime': 2,
        })

    def test_variable_dynamic_import_is_unproved_executable_code(self):
        temporary, root = self.fixture({
            'app.js': 'const mod = await import(config.driverUrl);\n',
        })
        try:
            result = audit_web_runtime(root)
        finally:
            temporary.cleanup()
        self.assertEqual(result['violation_counts'], {
            'unresolved-runtime-module': 1,
        })

    def test_literal_external_module_is_not_an_ownership_proof(self):
        temporary, root = self.fixture({
            'app.js': "import 'https://example.test/runtime.mjs';\n",
        })
        try:
            result = audit_web_runtime(root)
        finally:
            temporary.cleanup()
        self.assertEqual(result['violation_counts'], {
            'external-runtime-module': 1,
        })

    def test_repository_audit_finds_the_live_escape_routes(self):
        result = audit_web_runtime(ROOT / 'web')
        self.assertEqual(result['violation_counts'], {
            'direct-guest-wasm': 4,
            'host-language-memory': 5,
            'host-language-runtime': 4,
            'host-wasi-runtime': 2,
            'host-wasm-control': 4,
            'unresolved-runtime-module': 1,
        })
        self.assertIn('linux-worker.js', result['modules'])
        self.assertIn('run-worker.js', result['modules'])
        self.assertIn('drivers/compiler-core.js', result['modules'])
        modules = [row['module'] for row in result['alternate_owners']]
        self.assertEqual(modules, [
            'drivers/compiler-core.js', 'run-worker.js',
            'wasi-preview1.js', 'worker.js',
        ])
        self.assertNotIn('clang.js', modules)

    def test_linux_route_reaches_the_only_wasm_foundation(self):
        result = audit_web_runtime(
            ROOT / 'web', entries=['linux-terminal.js'])
        self.assertEqual(result['violation_counts'], {})
        self.assertIn('vm.js', result['modules'])
        self.assertTrue(any(
            edge['from'] == 'linux-worker.js'
            and edge['to'] == 'vm.js'
            for edge in result['edges']))

    def test_strict_cli_fails_on_repository_escape_routes(self):
        completed = subprocess.run([
            sys.executable, str(TOOLS / 'audit_runtime_routes.py'),
            '--web-root', str(ROOT / 'web'), '--strict',
        ], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 1, completed.stderr)
        report = json.loads(completed.stdout)
        self.assertTrue(report['violations'])


class TestProfileRuntimeRoutes(unittest.TestCase):
    def test_function_name_cannot_claim_vm_ownership(self):
        key = (str(ROOT / 'kernel' / 'x86.py'), 1,
               '_wasm_x86_step_executor')
        self.assertEqual(_profile_route(key, ROOT), 'host-kernel-x86')

    def test_same_profile_is_host_work_only_in_runtime_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            profile_path = Path(directory) / 'runtime.prof'
            profiler = cProfile.Profile()
            profiler.runcall(_profiled_project_work)
            profiler.dump_stats(profile_path)
            runtime = audit_profile(profile_path, phase='runtime')
            build = audit_profile(profile_path, phase='build')
        self.assertGreater(runtime['violations'].get('host-project', 0), 0)
        self.assertEqual(build['violations'], {})


if __name__ == '__main__':
    unittest.main()
