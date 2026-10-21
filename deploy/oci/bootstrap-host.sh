#!/usr/bin/env bash
# Prepara um servidor Ubuntu (22.04 ou 24.04; ARM64 da Oracle Always Free ou x86_64) para rodar o CÓRTEX com Docker Compose.
# EXECUTE NO SERVIDOR, como root (sudo), UMA vez, depois de criar a VM você mesmo no painel da nuvem (este script NÃO cria recurso de nuvem).
#
#   sudo bash deploy/oci/bootstrap-host.sh
#
# O que faz (e só isto):
#   1. confere sistema (Ubuntu) e arquitetura; mostra memória, disco e núcleos;
#   2. instala o Docker Engine + Compose pelo repositório APT OFICIAL do Docker (docker-ce, buildx, compose-plugin) e exige Compose >= 2.24.4
#      (os overrides docker-compose.staging/cloudflare usam !reset/!override);
#   3. cria um arquivo de swap de 4 GB se ainda não houver swap (o build do Next.js e do TypeScript tem pico de memória);
#   4. grava /etc/docker/daemon.json (rotação de logs 10 MB x 3, live-restore) SOMENTE se o arquivo não existir (nunca sobrescreve);
#   5. instala fail2ban (proteção de SSH) e atualizações automáticas de segurança (unattended-upgrades).
# O que NÃO faz: não abre/fecha portas, não cria usuário, não baixa o projeto, não gera .env (use deploy/oci/gen-env.sh), não sobe a pilha.
#
# FIREWALL — leia: o Docker publica portas por regras próprias do iptables e IGNORA o ufw. A barreira de rede correta é o GRUPO DE SEGURANÇA DA
# NUVEM (NSG/Security List): liberar entrada só em 22 (do SEU IP), 80 e 443 (dos IPs da Cloudflare, se usar o modo Cloudflare) e NADA mais. O compose
# já publica PostgreSQL e Redis só em 127.0.0.1 e fecha 3000/3001/3002 no staging. As imagens Ubuntu da Oracle trazem regras iptables próprias que
# podem bloquear 80/443 no próprio host — se o site não responder com o grupo de segurança certo, verifique `iptables -L INPUT -n` (não alterado aqui).
#
# NÃO FOI EXECUTADO em Linux nesta máquina de desenvolvimento (somente `bash -n`): rode primeiro numa VM descartável ou leia cada passo.
set -euo pipefail

if [ "$(id -u)" != "0" ]; then echo "execute como root: sudo bash $0" >&2; exit 1; fi
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then echo "este script foi escrito para Ubuntu (encontrado: ${ID:-desconhecido}); adapte os passos manualmente" >&2; exit 1; fi
ARCH="$(dpkg --print-architecture)"
case "$ARCH" in arm64|amd64) ;; *) echo "arquitetura não prevista: $ARCH (esperado arm64 ou amd64)" >&2; exit 1 ;; esac

echo "== Sistema: Ubuntu ${VERSION_ID:-?} ($ARCH) | núcleos: $(nproc) | memória: $(free -h | awk '/Mem:/{print $2}') | disco /: $(df -h / | awk 'NR==2{print $2" (livre "$4")"}')"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl gnupg git openssl fail2ban unattended-upgrades

# ---- Docker Engine pelo repositório oficial ----
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

COMPOSE_V="$(docker compose version --short 2>/dev/null || true)"
if [ -z "$COMPOSE_V" ]; then echo "docker compose não encontrado após a instalação" >&2; exit 1; fi
if [ "$(printf '%s\n%s\n' 2.24.4 "${COMPOSE_V#v}" | sort -V | head -n1)" != "2.24.4" ]; then
  echo "Docker Compose ${COMPOSE_V} é anterior a 2.24.4: atualize o plugin (os overrides usam !reset/!override)" >&2
  exit 1
fi

# ---- swap (só se não houver nenhum) ----
if [ "$(swapon --show --noheadings | wc -l)" = "0" ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "== swap de 4 GB criado"
else
  echo "== swap já existente: mantido"
fi

# ---- rotação de logs global do Docker (nunca sobrescreve um daemon.json existente) ----
if [ ! -e /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
EOF
  systemctl restart docker
  echo "== /etc/docker/daemon.json criado (rotação de logs 10 MB x 3, live-restore)"
else
  echo "== /etc/docker/daemon.json já existe: não alterado (confira se há rotação de logs)"
fi

# ---- segurança básica do host ----
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

echo
echo "== Pronto. Docker $(docker --version | awk '{print $3}' | tr -d ,) | Compose ${COMPOSE_V}"
echo "PRÓXIMOS PASSOS (docs/CORTEX/PRODUCAO.md §19): obter o projeto (git bundle/ZIP), rodar deploy/oci/gen-env.sh <dominio>, configurar a Cloudflare,"
echo "COMPOSE_PARALLEL_LIMIT=1 docker compose -f docker-compose.yml -f docker-compose.staging.yml -f docker-compose.cloudflare.yml -f docker-compose.free.yml up -d --build"
echo "(COMPOSE_PARALLEL_LIMIT=1 constrói uma imagem por vez: o pico de memória do build em paralelo não cabe com folga em 12 GB junto do banco)."
