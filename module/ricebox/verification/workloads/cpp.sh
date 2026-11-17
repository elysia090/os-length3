d=$(mktemp -d) || exit; trap 'rm -rf "$d"' EXIT; cd "$d" || exit
set -e
cat > sum.hpp <<'EOF'
int sum();
EOF
cat > sum.cpp <<'EOF'
#include <vector>
#include <numeric>
#include <stdexcept>
#include "sum.hpp"
int sum() { std::vector<int> v{12, 30}; try { throw std::runtime_error("ok"); } catch (const std::exception&) { return std::accumulate(v.begin(), v.end(), 0); } }
EOF
cat > main.cpp <<'EOF'
#include <iostream>
#include "sum.hpp"
int main() { std::cout << sum() << '\n'; return sum() != 42; }
EOF
c++ -std=c++17 -O2 main.cpp sum.cpp -o app
./app