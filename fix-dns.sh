#!/bin/bash
# Fix WSL DNS to resolve external domains like rpc-testnet.arc.network

# Stop WSL from auto-generating resolv.conf
sudo tee /etc/wsl.conf > /dev/null << 'EOF'
[network]
generateResolvConf = false
EOF

# Set Google DNS + keep original
sudo tee /etc/resolv.conf > /dev/null << 'EOF'
nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 10.255.255.254
search lan
EOF

echo "DNS fixed. Testing..."
nslookup rpc-testnet.arc.network 8.8.8.8 2>/dev/null | head -6
echo "Done."
