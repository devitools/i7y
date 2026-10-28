# Autenticação e tokens da API

## Para pessoas

O login usa email e senha da coleção `users`. Após validar as credenciais, o PocketBase retorna um token de sessão. O frontend usa esse token nas requisições de gerenciamento. O acesso depende dos vínculos com organizações e dos papéis `admin`, `editor` e `reader`. Tokens também ficam limitados a uma organização. Consulte [organizações](organizations.md) para os contratos de contexto, convites e permissões.

A coleção administrativa interna do PocketBase é reservada à manutenção técnica. Ela não é usada pelo login do i7y. A migração inicial copia os acessos administrativos já existentes para `users`, preservando o hash da senha. Não é necessário informar a senha novamente para a migração.

## Para agentes

Entre no i7y e clique em **Tokens da API → Criar token da API**. Escolha:

- **Nome:** identifica o agente ou a tarefa.
- **Permissão:** somente leitura, ou leitura e edição (inclui exclusão).
- **Validade:** de 1 a 365 dias; o padrão é 30 dias.

O segredo começa com `i7y_` e aparece somente após a criação. Copie-o e forneça ao agente junto com a URL do i7y. O agente não precisa receber email, senha ou token da sessão do navegador. Se perder o segredo, revogue a chave e crie outra.

Exemplo de instrução para um agente:

> Use a API do i7y em http://localhost:8097. O token estará na variável I7Y_TOKEN. Envie Authorization: Bearer seguido do token. Consulte os registros em /api/collections/containers/records. Não imprima nem salve o segredo em arquivos do projeto.

`localhost` refere-se à máquina onde o agente executa. Um agente remoto precisa de uma URL acessível a ele; a instalação padrão do Docker publica o serviço somente na máquina local.

```sh
curl --get http://localhost:8097/api/collections/containers/records \
  -H "Authorization: Bearer $I7Y_TOKEN" \
  --data-urlencode 'expand=project.server.workspace' \
  --data-urlencode 'perPage=50'
```

Um token de leitura e edição também pode usar `POST`, `PATCH` e `DELETE` nos quatro recursos de inventário. Ele não inicia nem para containers reais.

## Limites de acesso

| Credencial | Acesso |
| --- | --- |
| Token da sessão do usuário | Inventário, seu próprio perfil e gerenciamento dos seus tokens |
| Token de agente: leitura | GET de registros dos quatro recursos |
| Token de agente: leitura e edição | GET, POST, PATCH e DELETE de registros dos quatro recursos |

Tokens de agentes não acessam usuários, configurações, autenticação, renovação de sessão, criação de tokens, operações em lote ou realtime. As permissões abrangem os workspaces da organização do token do inventário. São aceitos no cabeçalho `Authorization`, com ou sem o prefixo `Bearer`; prefira o formato `Bearer` nos clientes.

O inventário é privado. Todas as consultas e alterações exigem uma sessão de usuário ou token de agente válido. Sem autenticação, os endpoints de registros retornam HTTP 401. O frontend redireciona qualquer tela protegida para o login e retoma o link solicitado após entrar. O login não carrega registros nem exibe a navegação privada.

## Validade e revogação

O servidor verifica o hash do token e sua validade em cada requisição. Ele não guarda o segredo em texto puro. A listagem mostra nome, prefixo, permissão e vencimento.

Abra **Tokens da API → Revogar** para revisar a chave e confirmar a revogação em uma página própria. A chave deixa de funcionar nas chamadas seguintes. Sua sessão e as outras chaves continuam válidas. A exclusão do usuário remove suas chaves em cascata; a troca de senha não substitui a revogação das chaves.

Quando o token expirar, crie outro. Agentes não podem renovar o próprio token nem emitir chaves adicionais. Cada usuário pode manter até 100 chaves; revogue as que não usa.

## API de gerenciamento de chaves

Estes endpoints exigem o token de sessão de um usuário `users`, obtido pelo login. Tokens de agentes não podem acessá-los.

| Método e caminho | Comportamento |
| --- | --- |
| `GET /api/i7y/tokens` | Lista somente os metadados das suas chaves |
| `POST /api/i7y/tokens` | Cria uma chave e retorna o segredo uma única vez |
| `DELETE /api/i7y/tokens/ID` | Revoga uma chave sua |

Exemplo de criação:

```sh
curl http://localhost:8097/api/i7y/tokens \
  -H "Authorization: Bearer $I7Y_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"Agente de revisão","scope":"read","days":30}'
```

O sucesso retorna HTTP 201 com `id`, `label`, `prefix`, `scope`, `expires_at`, `created` e `token`. A listagem nunca retorna `token` nem seu hash. Um agente pode consultar `GET /api/i7y/token` para verificar o nome, a permissão e o vencimento da própria chave, sem acesso às demais. A revogação retorna HTTP 204. Token de agente inválido, expirado ou revogado retorna 401; tentativa fora do escopo retorna 403.

## Validação de desenvolvimento

`tests/api-tokens.integration.py` verifica as permissões, limites de rotas, revogação, expiração e isolamento entre usuários contra um backend descartável. Configure `I7Y_TEST_URL`, `I7Y_TEST_EMAIL` e `I7Y_TEST_PASSWORD`; o ambiente de teste deve ter um usuário e um superusuário com as mesmas credenciais de teste. O script cria e exclui registros de teste. Execute apenas em ambiente descartável, nunca no inventário de trabalho.

## Primeiro acesso em uma instalação vazia

Em uma instalação local confiável, crie um superusuário de manutenção usando o PocketBase:

```sh
read -r -s I7Y_BOOTSTRAP_PASSWORD
export I7Y_BOOTSTRAP_PASSWORD
docker compose exec -e I7Y_BOOTSTRAP_PASSWORD pocketbase sh -c '/pb/bin/0.40.4/pocketbase superuser upsert admin@example.test "$I7Y_BOOTSTRAP_PASSWORD" --dir=/pb/pb_data'
unset I7Y_BOOTSTRAP_PASSWORD
```

Substitua o email de exemplo. Abra `http://127.0.0.1:8097/_/` na máquina local e entre com esse acesso de manutenção. Na coleção `users`, crie o usuário humano com email, senha e `global_admin=true`. Na coleção `organization_memberships`, associe esse usuário à organização inicial com papel `admin`. Entre no i7y usando o usuário humano. O superusuário de manutenção não é uma conta de login do i7y e deve permanecer restrito à administração local.

Em servidores remotos, use um túnel SSH para a porta de loopback. Não exponha o painel administrativo publicamente. Senhas e dados da instalação não devem ser salvos no repositório.
