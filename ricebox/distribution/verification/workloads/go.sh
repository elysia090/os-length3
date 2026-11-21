d=$(mktemp -d) || exit; trap 'rm -rf "$d"' EXIT; cd "$d" || exit
set -e
cat > go.mod <<'EOF'
module ricebox.test/assay
go 1.20
EOF
cat > answer.go <<'EOF'
package answer
func Answer()int{return 42}
EOF
cat > answer_test.go <<'EOF'
package answer
import "testing"
func TestAnswer(t *testing.T) { if Answer() != 42 { t.Fatal("wrong answer") } }
EOF
gofmt -w answer.go answer_test.go
[ -z "$(gofmt -l answer.go answer_test.go)" ]
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOCACHE="$d/cache" go test ./... > result 2>&1 || { cat result; exit 1; }
echo go-project-ok