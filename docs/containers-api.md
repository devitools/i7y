# API de containers

A API gerencia os registros do inventário i7y. As operações não criam, iniciam, param ou removem containers nos hosts Docker.

## Autenticação

O login usa a coleção `users`, conforme o [guia de autenticação](api-auth.md). Leituras e escritas exigem uma sessão de usuário ou token de agente válido.

```sh
curl http://localhost:8097/api/collections/users/auth-with-password \
  -H 'Content-Type: application/json' \
  -d '{"identity":"usuario@example.com","password":"SUA_SENHA"}'
```

Copie o campo `token` da resposta para a variável `I7Y_TOKEN` da sua sessão de terminal. Não salve o token no código.

## Listar e localizar um project

O container pertence a um project existente, identificado pelo ID do registro.

```sh
curl --get http://localhost:8097/api/collections/projects/records \
  -H "Authorization: Bearer $I7Y_TOKEN" \
  --data-urlencode 'filter=name="meu-app"' \
  --data-urlencode 'expand=server.workspace'
```

A resposta paginada contém `page`, `perPage`, `totalItems`, `totalPages` e `items`. Use o `id` do item correto como `PROJECT_ID` nos exemplos abaixo.

## Cadastrar

```sh
curl http://localhost:8097/api/collections/containers/records \
  -H "Authorization: $I7Y_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"project":"PROJECT_ID","name":"meu-app.web","image":"nginx:1.27","sort_order":0}'
```

O sucesso retorna HTTP 200 e o registro criado, incluindo `id`. `project` é uma relação obrigatória. Use `name` e `image` preenchidos para identificar o container e a versão da imagem. `sort_order` é um número opcional usado na ordenação. Nome e imagem são metadados; a API não verifica a existência da imagem em um registry.

## Listar e filtrar

```sh
curl --get http://localhost:8097/api/collections/containers/records \
  -H "Authorization: Bearer $I7Y_TOKEN" \
  --data-urlencode 'page=1' \
  --data-urlencode 'perPage=50' \
  --data-urlencode 'filter=project="PROJECT_ID"' \
  --data-urlencode 'sort=sort_order,name' \
  --data-urlencode 'expand=project.server.workspace'
```

Para buscar uma imagem exata, use `filter=image="nginx:1.27"`. A expansão traz as relações em `expand`, sem alterar os IDs dos campos originais.

## Consultar um container

```sh
curl 'http://localhost:8097/api/collections/containers/records/CONTAINER_ID?expand=project.server.workspace' \
  -H "Authorization: Bearer $I7Y_TOKEN"
```

## Editar imagem, nome ou project

Envie somente os campos a alterar. Trocar `project` move o registro para outro project do inventário.

```sh
curl -X PATCH http://localhost:8097/api/collections/containers/records/CONTAINER_ID \
  -H "Authorization: $I7Y_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"image":"nginx:1.28","name":"meu-app.web"}'
```

O sucesso retorna HTTP 200 e o registro atualizado.

## Excluir

```sh
curl -X DELETE http://localhost:8097/api/collections/containers/records/CONTAINER_ID \
  -H "Authorization: $I7Y_TOKEN"
```

O sucesso retorna HTTP 204, sem corpo. A exclusão é permanente no inventário. Excluir o project, server ou workspace pai também remove seus containers em cascata.

## Erros

As respostas de erro usam JSON com `status`, `message` e, quando houver validação, `data` com os erros por campo. Relação inválida ou criação sem permissão pode retornar 400. Registro inexistente ou edição/exclusão não permitida pode retornar 404; esse status sozinho não distingue ausência de permissão de registro inexistente.

Para renovar uma sessão válida, envie `POST /api/collections/users/auth-refresh` com `Authorization: TOKEN`. Quando a sessão expirar, entre novamente.

## Cliente JavaScript do i7y

Dentro do frontend, o cliente compartilhado usa a mesma sessão do login da interface:

```js
import { management } from './api'

const result = await management.list('containers', {
  page: 1,
  perPage: 50,
  filter: `project="${projectId}"`,
})
const container = await management.create('containers', {
  project: projectId,
  name: 'meu-app.web',
  image: 'nginx:1.27',
})
await management.update('containers', container.id, { image: 'nginx:1.28' })
await management.remove('containers', container.id)
```

Reinícios normais preservam as alterações no banco. A importação legada de inventário é opcional e exige configuração explícita do backend.

## Acesso de agentes sem senha

Para agentes, prefira um token criado em **Tokens da API** no i7y. Use `Authorization: Bearer TOKEN`; não forneça as credenciais do usuário. O [guia de autenticação](api-auth.md) explica permissões, validade, revogação e exemplos.
