d=$(mktemp -d) || exit; trap 'rm -rf "$d"' EXIT; cd "$d" || exit
set -e
cat > test_project.py <<'EOF'
import json, sqlite3, ssl, subprocess, unittest
class Project(unittest.TestCase):
    def test_work(self):
        db = sqlite3.connect(":memory:")
        self.assertEqual(db.execute("select 12 + 30").fetchone()[0], 42)
        self.assertEqual(json.loads('{"answer":42}')["answer"], 42)
        self.assertEqual(subprocess.check_output(["sh", "-c", "printf child"]).decode(), "child")
        self.assertIsNotNone(ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT))
EOF
python3 -m unittest test_project > result 2>&1 || { cat result; exit 1; }
echo python-project-ok