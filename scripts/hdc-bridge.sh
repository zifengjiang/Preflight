# hdc bridge
# Usage: eval "$(hdc-bridge.sh)" or source it
# Should not be executed directly
echo "hdc() { command hdc -s \"${HDC_S:-127.0.0.1:17815}\" \"\$@\"; }"
