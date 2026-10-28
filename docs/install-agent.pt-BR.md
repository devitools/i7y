# Instalar o daemon do i7y em um servidor

Este guia instala o `i7y-agent` em um servidor Linux com Docker e systemd. O agente inicia no boot, coleta imediatamente e depois a cada cinco minutos. Ele mantém o estado dos containers e as imagens em uso atualizados no i7y, com histórico de telemetria.

O agente também acompanha eventos do Docker pelo socket local. Criação, início, parada, remoção e mudanças de saúde disparam uma reconciliação rápida, agrupando eventos por dois segundos. Ao reconectar, ele reconcilia o estado para recuperar eventos perdidos. A coleta completa de métricas continua a cada cinco minutos; eventos durante essa coleta são processados em seguida. Na lista de containers, removidos ficam ocultos por padrão; habilite Mostrar containers removidos para consultá-los. A lista aberta atualiza automaticamente a cada dez segundos.

A instalação não reinicia nem altera os containers das aplicações. Ela exige acesso administrativo para criar o usuário e o serviço do agente. O acesso ao socket Docker é privilegiado; use somente o binário de origem confiável e proteja a configuração.

Os endereços, usuários e credenciais abaixo são exemplos fictícios. Substitua-os pelos valores do ambiente.

## 1. Preparar os arquivos

Na máquina que contém o código do i7y, entre na pasta `apps/agent`. Com o Go instalado, gere os binários e os checksums:

```sh
go test -race ./...
./build.sh
```

O módulo fixa a versão do toolchain. O build gera:

- `dist/i7y-agent-linux-amd64`: servidores Intel/AMD de 64 bits.
- `dist/i7y-agent-linux-arm64`: servidores ARM de 64 bits.
- `dist/SHA256SUMS`: checksums dos dois binários.

O servidor de destino não precisa ter Go, Node ou Python instalado para executar o agente. Se já recebeu os binários de uma fonte confiável, pode pular o build.

## 2. Conferir o servidor de destino

Entre por SSH, usando a porta e a identidade corretas. Valide a chave do host com uma fonte confiável antes de aceitar um servidor desconhecido.

```sh
ssh -p 22 operador@server.example.com
uname -m
systemctl --version
docker version
getent group docker
```

Escolha o binário conforme `uname -m`:

| Resultado | Binário |
| --- | --- |
| `x86_64` | `i7y-agent-linux-amd64` |
| `aarch64` ou `arm64` | `i7y-agent-linux-arm64` |

Confirme também que o servidor consegue alcançar o i7y em HTTPS:

```sh
curl --fail --show-error https://inventory.example.com/api/health
```

A API deve retornar HTTP 200. Corrija problemas de DNS ou certificado antes de instalar; não desative a validação TLS.

Este instalador pressupõe que o Docker utiliza o socket local `/var/run/docker.sock` e que existe o grupo `docker`. Se essas condições não forem verdadeiras, adapte o serviço ao ambiente antes de continuar.

## 3. Criar a credencial no i7y

1. Entre no i7y com seu usuário.
2. Cadastre o servidor, se ele ainda não existir, dentro do workspace correto.
3. Abra **Telemetria** e expanda **Configurações do agente**.
4. Selecione o servidor pelo nome cadastrado, conferindo seu IP na tela **Servidores / Servers**.
5. Clique em **Criar credencial / Create credential** e confirme.
6. Copie o segredo exibido. Ele começa com `i7ya_` e só aparece na criação.

Use uma credencial diferente para cada servidor. A credencial é vinculada ao registro selecionado e só permite consultar a configuração e enviar telemetria daquele servidor. Ela não é o token geral de gerenciamento da API. Para os exemplos deste guia, use a URL da sua própria instalação no lugar de `https://inventory.example.com`.

Se já houver um agente instalado, não rotacione a credencial sem planejar a atualização da configuração: criar outra para o mesmo servidor invalida a anterior imediatamente.

## 4. Copiar os arquivos

Ainda no servidor, prepare uma pasta temporária privada:

```sh
install -d -m 0700 "$HOME/i7y-install"
```

Na máquina onde foi feito o build, dentro de `apps/agent`, copie os arquivos. Este exemplo usa `amd64`:

```sh
scp -P 22 \
  dist/i7y-agent-linux-amd64 \
  dist/SHA256SUMS \
  deploy/install.sh \
  deploy/i7y-agent.service \
  operador@server.example.com:~/i7y-install/
```

Se necessário, acrescente `-i /caminho/da/chave` aos comandos SSH e SCP. Não copie a chave privada para o servidor.

No servidor, confira o checksum do binário recebido:

```sh
cd "$HOME/i7y-install"
awk '$2 == "i7y-agent-linux-amd64" { print }' SHA256SUMS > selected.sha256
test -s selected.sha256
sha256sum -c selected.sha256
chmod 0755 i7y-agent-linux-amd64
./i7y-agent-linux-amd64 -version
```

O checksum deve retornar `OK`. Para ARM, troque `amd64` por `arm64` nos comandos.

## 5. Criar a configuração privada

No servidor, crie o arquivo com permissão restrita e abra-o em um editor:

```sh
cd "$HOME/i7y-install"
install -m 0600 /dev/null config.json
vi config.json
```

Preencha o arquivo, substituindo a URL e o token pelos valores reais:

```json
{
  "url": "https://inventory.example.com",
  "token": "i7ya_COLE_A_CREDENCIAL_DESTE_SERVIDOR",
  "docker_socket": "/var/run/docker.sock",
  "state_dir": "/var/lib/i7y-agent",
  "roots": ["/usr/share/tevun/projects", "/usr/share/tevun"]
}
```

`roots` define onde o agente procura projetos. Use os caminhos físicos confirmados com `readlink -e /projects` e `readlink -e /usr/share/tevun`, ajustando o exemplo ao servidor; diretórios inexistentes são ignorados. O usuário do agente precisa conseguir ler e atravessar esses diretórios. Não conceda escrita nos arquivos das aplicações para permitir a coleta.

O agente também recebe do i7y os caminhos dos projetos já cadastrados. Ele resolve symlinks, envia e mantém no inventário o caminho físico e reconhece o diretório do Compose dentro de um projeto existente, preservando o vínculo quando não há ambiguidade.

Não coloque a credencial em comandos, histórico do terminal, repositórios, prints ou chamados de suporte. Não execute `cat config.json` durante sessões com saída compartilhada.

## 6. Instalar e iniciar o serviço

No servidor:

```sh
cd "$HOME/i7y-install"
sudo sh install.sh \
  ./i7y-agent-linux-amd64 \
  ./config.json \
  ./i7y-agent.service
```

Se o usuário SSH não estiver no `sudoers`, use um acesso administrativo já autorizado. Por exemplo, entre como root com `su -` e execute o mesmo instalador sem o prefixo `sudo`, usando os caminhos absolutos da pasta de preparação. Não é necessário conceder sudo ao usuário SSH para instalar o agente.

O instalador cria:

| Local | Função |
| --- | --- |
| `/usr/local/bin/i7y-agent` | Executável |
| `/etc/i7y-agent/config.json` | Configuração e credencial, modo `0600` |
| `/etc/systemd/system/i7y-agent.service` | Serviço systemd |
| `/var/lib/i7y-agent` | Fila persistente e trava do processo |

Ele cria o usuário de sistema `i7y-agent`, habilita o serviço no boot e o inicia. O serviço recebe acesso ao grupo `docker` pela configuração do systemd.

## 7. Validar a instalação

Confira o serviço:

```sh
systemctl is-enabled i7y-agent
systemctl is-active i7y-agent
sudo journalctl -u i7y-agent -n 30 --no-pager
```

Os resultados esperados são `enabled` e `active`. Depois da coleta, os logs devem mostrar mensagens como:

```text
collected 12 containers; errors=0
queue delivered
```

A primeira coleta pode demorar, dependendo da quantidade de containers. O agente coleta imediatamente ao iniciar; não é necessário aguardar cinco minutos para ela começar.

Para testar autenticação e acesso ao Docker sem enviar outra amostra:

```sh
sudo -u i7y-agent -g docker \
  /usr/local/bin/i7y-agent \
  -config /etc/i7y-agent/config.json \
  -diagnose
```

O diagnóstico deve informar `API and Docker available`. O `-g docker` reproduz o acesso ao grupo que o serviço recebe pelo systemd.

No i7y, abra **Telemetria**, selecione o servidor e clique em **Atualizar / Refresh**. Confirme:

- Versão do agente e último contato recentes.
- Lista de containers compatível com `docker ps -a`.
- Imagens iguais às referências configuradas nos containers reais.
- Métricas e histórico preenchidos, sem erros inesperados de coleta.

Após trocar a imagem e recriar um container no servidor, a próxima coleta atualiza o campo `image` do inventário automaticamente. Apenas baixar uma imagem com `docker pull` não muda a imagem do container existente.

Depois da validação, remova a cópia temporária da credencial:

```sh
rm -i "$HOME/i7y-install/config.json"
```

A configuração utilizada pelo serviço permanece em `/etc/i7y-agent/config.json`.

## 8. Atualizar o agente

Gere ou receba o novo binário e verifique seu checksum. Não é necessário criar outra credencial nem reinstalar os containers.

Com o novo binário já no servidor:

```sh
sudo cp -p /usr/local/bin/i7y-agent /usr/local/bin/i7y-agent.previous
sudo install -m 0755 ./i7y-agent-linux-amd64 /usr/local/bin/i7y-agent.next
sudo mv /usr/local/bin/i7y-agent.next /usr/local/bin/i7y-agent
sudo systemctl restart i7y-agent
/usr/local/bin/i7y-agent -version
sudo journalctl -u i7y-agent -n 15 --no-pager
```

A substituição por rename evita sobrescrever um executável em uso. A configuração e a fila são preservadas. Confirme a nova versão na próxima amostra do i7y.

Se precisar restaurar o binário anterior:

```sh
sudo install -m 0755 /usr/local/bin/i7y-agent.previous /usr/local/bin/i7y-agent.next
sudo mv /usr/local/bin/i7y-agent.next /usr/local/bin/i7y-agent
sudo systemctl restart i7y-agent
```

## 9. Resolver problemas comuns

| Sintoma | Verificação |
| --- | --- |
| `configuration must have mode 0600` | Confira as permissões com `sudo stat /etc/i7y-agent/config.json`. |
| `API HTTP 401` | Confirme se a credencial pertence ao servidor e se foi revogada ou rotacionada. |
| `API HTTP 403` | Confira as regras do proxy e da Cloudflare para o endpoint de telemetria. |
| `API connection failed` | Verifique DNS, conectividade HTTPS, certificado e URL da configuração. |
| `Docker unavailable` | Confira se o Docker está ativo, o socket configurado e o acesso do serviço ao grupo `docker`. |
| `project path inaccessible` | Confira leitura e travessia dos diretórios pelo usuário `i7y-agent`. |
| `another agent is running` | Há outro processo usando a mesma fila; use a instância gerenciada pelo systemd. |
| Projeto ou vínculo ambíguo | Revise os caminhos e vínculos no inventário; o agente preserva cadastros existentes em vez de mover containers silenciosamente. |
| Sem comunicação no painel | Confira o serviço e os logs; o painel sinaliza ausência de contato após 15 minutos. |

Durante uma falha de rede, o agente mantém uma fila local de até 24 horas/288 amostras e tenta reenviar com backoff. O backend reconhece amostras repetidas para não duplicar o histórico.

Se `/projects` for um symlink para uma pasta dentro de `/home`, confira todo o caminho com `namei -l /projects`. Um diretório pessoal com modo `0700` impede o acesso mesmo quando o destino permite leitura. Quando necessário, conceda somente travessia ao usuário do agente no diretório ancestral, por exemplo `sudo setfacl -m u:i7y-agent:--x /home/operador`. Isso não concede listagem desse diretório; os diretórios dos projetos ainda precisam permitir a leitura necessária à descoberta. Reinicie apenas `i7y-agent` e confirme o próximo envio.

## 10. Parar ou remover

Para parar temporariamente:

```sh
sudo systemctl stop i7y-agent
```

Para iniciar novamente:

```sh
sudo systemctl start i7y-agent
```

Para remover o serviço e o binário, use `apps/agent/deploy/uninstall.sh` do código-fonte:

```sh
sudo sh uninstall.sh
```

O script preserva a configuração e a fila. Revogue a credencial pela tela de telemetria caso o servidor deixe de enviar dados definitivamente. A remoção do agente não exclui os projetos nem os containers do inventário e não interfere nos containers reais.
