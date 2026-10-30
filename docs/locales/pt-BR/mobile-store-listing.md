# i7y — rascunhos para publicação

Material não publicado. Revisão técnica em 29/10/2026. Os textos abaixo precisam da aprovação do publicador e da confirmação dos serviços reais. Não são uma declaração de conformidade, um formulário de privacidade preenchido nem uma publicação nas lojas. Substitua todos os campos entre colchetes antes de usar os textos.

## Metadados em português brasileiro

| Campo | Rascunho |
| --- | --- |
| Nome | i7y |
| Nome alternativo para avaliação | i7y — Incidentes |
| Subtítulo para App Store | Sua resposta a incidentes |
| Descrição curta para Google Play | Acompanhe e responda a incidentes do seu servidor i7y. |
| Palavras-chave propostas para Apple | incidentes,monitoramento,infraestrutura,alertas,equipe,servidor |
| Categoria proposta | Produtividade; confirmar com o publicador |
| Novidades da versão inicial | Primeira versão do aplicativo i7y para acompanhar e responder a incidentes. |

### Descrição completa

Acompanhe os incidentes da sua instalação i7y e organize a resposta da equipe pelo celular ou tablet.

Conecte o endereço do seu servidor, entre com sua conta e selecione uma organização. Consulte incidentes por estado e severidade, veja detalhes e evidências e acompanhe o histórico de atendimento. Conforme seu papel na organização, assuma um incidente, escolha um prazo, estenda a responsabilidade e marque a ocorrência como resolvida.

Quando sua instalação e o serviço de notificações estiverem configurados, você também poderá ativar alertas neste dispositivo. As notificações levam apenas um resumo mínimo; os detalhes são consultados no servidor após a autenticação. A entrega depende das permissões do sistema, da conexão e dos serviços de notificação.

É necessário ter acesso a uma instalação i7y compatível e a uma conta autorizada. O aplicativo não cria uma instalação de monitoramento nem concede acesso às organizações. A entrada é aprovada pelo navegador do seu próprio servidor. O administrador da instalação define os acessos e os dados disponíveis.

### Antes de enviar

Confirmar nome público, titular da marca, categoria, preço, países, classificação indicativa e idiomas da ficha. Publicar URLs reais de privacidade e suporte. Não usar os endereços de conta Apple/Google como suporte público sem autorização explícita. Não prometer entrega garantida de alertas ou funcionamento como serviço de emergência.

## Acesso privado para revisão das lojas

Este bloco é um modelo para os campos privados de revisão. Senhas reais não devem ser incluídas neste repositório nem na descrição pública.

- Servidor HTTPS de demonstração: `[REVIEW_SERVER_HTTPS_ORIGIN]`.
- Usuário de demonstração: `[REVIEW_USERNAME]`.
- Senha: fornecer em campo privado apropriado; `[REVIEW_PASSWORD_DELIVERED_PRIVATELY]`.
- Organização: `[REVIEW_ORGANIZATION_NAME]`.
- Papel: `[REVIEW_ROLE]`; editor ou administrador para testar ações.
- Incidentes sintéticos disponíveis: `[REVIEW_INCIDENT_NAMES]`.
- Contato privado para revisão: `[PRIVATE_REVIEW_CONTACT]`.
- Disponibilidade e procedimento para restaurar os dados: `[REVIEW_AVAILABILITY_AND_RESET]`.
- Estado real do teste remoto de notificações: `[REMOTE_PUSH_REVIEW_STATUS]`.

### Instruções ao revisor

1. Abra o aplicativo e informe o servidor HTTPS de demonstração no campo de endereço. Esse endereço é uma configuração feita no próprio aplicativo, e não um código promocional.
2. Toque em verificar servidor e depois em entrar pelo navegador.
3. No navegador, entre com as credenciais de demonstração fornecidas privadamente. Compare o código apresentado com o código do aplicativo e aprove a entrada. Retorne ao aplicativo pelo botão oferecido.
4. Selecione a organização informada. Abra um incidente sintético para consultar detalhes, evidências e histórico.
5. Com a conta de editor/administrador, assuma um incidente e escolha um prazo. Estenda esse prazo e resolva uma ocorrência de demonstração. Uma conta de leitura não oferece essas ações.
6. Em Ajustes, confira servidor, conta, organização e estado das notificações. Ative notificações somente se o estado informado neste pacote confirmar que a versão e os serviços remotos estão configurados. Aceite a permissão do sistema e aguarde a confirmação de cadastro.
7. Quando houver um teste remoto preparado, `[REMOTE_PUSH_REVIEW_TRIGGER]`. Ao tocar no alerta, o aplicativo valida a conexão e consulta o incidente autorizado no servidor.

O revisor não deve precisar de VPN, rede local, convite de funcionário, credencial pessoal ou liberação manual temporária. O publicador deve manter a demonstração disponível durante toda a revisão. Não preencher esse modelo com um endereço inventado. O gateway ainda não foi implantado e não há credenciais de provedor fornecidas nesta preparação.

## Plano de imagens em português

Capturar a interface nativa real com dados sintéticos: conexão ao servidor, lista de incidentes com filtros, detalhes e evidências seguras, responsabilidade com prazo e estado resolvido, além dos ajustes de notificações. Não exibir endereços privados, e-mails reais, tokens ou evidências de clientes.

As imagens públicas devem corresponder à versão enviada. Uma captura obtida por injeção local de notificação não demonstra entrega por APNs/FCM. Guardar a comprovação de transporte remoto separadamente, com ambiente, versão, horário, evento sintético e resultado, sem segredos. Os tamanhos por plataforma e os links oficiais estão no [guia de preparação](../../mobile-store-listing.md).

## Rascunho de página pública de privacidade

**Não publicar antes de confirmar os campos e as práticas abaixo.**

### Privacidade no i7y

Última atualização: `[POLICY_EFFECTIVE_DATE]`.

O aplicativo i7y é disponibilizado por `[LEGAL_PUBLISHER_NAME]`. Para dúvidas sobre este aviso, entre em contato por `[PUBLIC_PRIVACY_CONTACT]`. A identidade jurídica, os papéis de cada operador e os canais de atendimento precisam ser confirmados pelo publicador antes da publicação desta página.

O aplicativo se conecta ao servidor i7y que você informa. A organização responsável por esse servidor administra contas, acessos, incidentes e evidências. Os dados disponíveis dependem de sua conta e de suas permissões. Consulte também o aviso de privacidade da instalação e as orientações de seu administrador.

#### Conta e conexão

A entrada é aprovada no navegador do servidor escolhido. A senha é informada nesse servidor; o aplicativo recebe uma sessão e dados básicos da conta, como identificador, nome e e-mail quando fornecidos pelo servidor. A sessão é mantida no armazenamento seguro da plataforma. O aplicativo também mantém preferências de conexão, como endereço do servidor e organização selecionada.

Ao consultar incidentes ou executar ações, o aplicativo troca dados com esse servidor. Detalhes, evidências e histórico podem conter informações inseridas pela organização. Assumir, estender ou resolver um incidente pode gerar um registro de auditoria no servidor. A política de retenção desses registros deve ser informada pelo responsável pela instalação.

#### Notificações opcionais

Se você ativar notificações, o aplicativo solicita permissão ao sistema e registra o token nativo do dispositivo no gateway configurado pelo publicador. O gateway mantém esse destino de forma criptografada e verifica a posse do dispositivo antes de permitir o envio. O servidor i7y recebe uma autorização limitada e revogável para enviar a essa conexão; não recebe o token nativo nem a credencial de gerenciamento do dispositivo.

As mensagens passam pelo gateway e pelos serviços Apple Push Notification service ou Firebase Cloud Messaging. Elas contêm um resumo genérico, severidade e identificadores necessários para encaminhar a abertura do incidente. Os detalhes e evidências são buscados no servidor após a autenticação e não integram o resumo de push produzido pelo aplicativo/servidor atual. Isso não significa que o transporte seja anônimo ou tenha criptografia de ponta a ponta: os operadores envolvidos recebem os dados necessários à prestação do serviço.

Você pode desativar notificações nos Ajustes do aplicativo e nas permissões do sistema. Quando a remoção no gateway não pode ser confirmada por falta de conexão, o aplicativo mantém uma solicitação pendente para nova tentativa. Alertas já entregues ao provedor podem chegar durante seu curto período de validade.

#### Uso, destinatários e segurança

Essas informações são usadas para autenticar a conexão, apresentar os incidentes autorizados, registrar ações e entregar notificações quando ativadas. Os destinatários incluem a instalação escolhida, `[GATEWAY_OPERATOR]`, seus provedores de infraestrutura confirmados e os serviços de notificação aplicáveis. A lista final de operadores, regiões de processamento e transferências deve constar em `[CONFIRMED_PROCESSOR_AND_REGION_DETAILS]`.

A configuração de produção exige HTTPS. Tokens nativos são criptografados no banco do gateway e capacidades são protegidas no armazenamento apropriado. Essas medidas não eliminam todos os riscos nem substituem a administração segura do servidor e dos serviços associados.

A configuração atual não inclui um produto de publicidade ou analytics no código do cliente. O publicador ainda deve confirmar o comportamento de todos os SDKs, registros de hospedagem, relatórios de falhas e integrações de sua distribuição antes de fazer declarações públicas sobre rastreamento, compartilhamento ou categorias de dados.

#### Retenção, exclusão e seus direitos

O gateway atual armazena recibos contendo hashes e estado, sem o corpo das notificações, com retenção configurada de sete dias e limpeza periódica. Provas de cadastro expiram em cinco minutos. O servidor conserva registros terminais da fila de envio por trinta dias antes de sua limpeza periódica. Essas janelas técnicas não constituem, por si só, a política completa de retenção: cópias de segurança, registros de acesso, contas, incidentes e evidências precisam de regras próprias confirmadas.

Os registros de destinos e vínculos revogados no gateway ainda não têm uma política automática completa de eliminação. Antes da publicação, o publicador deve definir o prazo, o procedimento efetivo e as exceções aplicáveis em `[CONFIRMED_RETENTION_AND_DELETION_POLICY]`. Não anunciar exclusão imediata de todos os dados apenas porque uma autorização foi revogada.

Sair da conta remove a sessão local e inicia a remoção da autorização de notificações. Isso não exclui sua conta nem o histórico mantido pelo servidor. Para exercer os direitos aplicáveis e solicitar informações ou exclusão, use `[CONFIRMED_PRIVACY_REQUEST_CHANNEL]` e as instruções do responsável por sua instalação. A página final deve explicar o procedimento, a verificação de identidade, os prazos e eventuais retenções necessárias: `[CONFIRMED_RIGHTS_REQUEST_PROCEDURE]`.

Se o fluxo oferecido pelo aplicativo permitir criar uma conta, o publicador deve oferecer e documentar os caminhos de exclusão exigidos pelas lojas, inclusive quando a criação ocorrer pelo navegador. O texto desta página não substitui essa funcionalidade. Confirmar o enquadramento e o caminho em `[CONFIRMED_ACCOUNT_DELETION_PATH]` antes de enviar às lojas.

## Rascunho de página pública de suporte

**Não publicar antes de fornecer contato e URLs reais.**

### Suporte ao i7y

O i7y é um aplicativo para acessar uma instalação i7y existente. Para suporte ao aplicativo, fale com `[PUBLIC_SUPPORT_CONTACT]`. Para permissões, dados e disponibilidade do seu servidor, procure o administrador de sua organização. Responsável pelo aplicativo: `[LEGAL_PUBLISHER_NAME]`.

**Não consigo conectar.** Informe a origem HTTPS completa fornecida pelo administrador, sem caminho, senha ou parâmetros adicionais. Confirme que o servidor está acessível pela rede que você usa e que possui suporte ao protocolo móvel. Não envie sua senha ao suporte.

**Não consigo entrar.** Use a conta da instalação escolhida. Compare os códigos no aplicativo e no navegador antes de aprovar. Se cancelar, expirar ou mudar de servidor, inicie uma nova tentativa. Solicite ao administrador a recuperação de acesso quando necessário.

**Não vejo uma organização ou incidente.** A conta precisa de participação na organização. O administrador pode ter alterado seus acessos, removido a ocorrência ou restringido as ações ao seu papel. Atualize os dados e confirme o acesso com sua organização.

**Não recebo notificações.** Confirme a permissão do sistema e o estado em Ajustes. O servidor e a versão instalada precisam apontar para o mesmo gateway configurado. Se houver remoção pendente, tente novamente com conexão. Notificações dependem dos serviços e das condições do sistema; use a lista do aplicativo para consultar o estado atualizado dos incidentes.

**Uma ação teve resultado incerto.** Atualize o incidente antes de repetir a ação. O servidor pode ter processado a solicitação mesmo que a resposta não tenha chegado ao aplicativo.

**Privacidade e exclusão.** Consulte `[PUBLIC_PRIVACY_POLICY_URL]` e o caminho confirmado de solicitação `[PUBLIC_DELETION_URL_OR_APPLICABLE_REQUEST_PATH]`. Desativar notificações ou sair da conta não exclui automaticamente os registros mantidos por sua instalação.

Ao pedir ajuda, informe versão do aplicativo, sistema operacional, horário aproximado, etapa que falhou e mensagem apresentada. Oculte identificadores privados. Não envie senha, token de sessão, token de push, credencial de gerenciamento, segredo de API ou evidência de clientes. O suporte responderá conforme `[CONFIRMED_SUPPORT_HOURS_AND_EXPECTATIONS]`; nenhum prazo de atendimento é prometido por este rascunho.

## Declarações das lojas: confirmação pendente

Os formulários App Privacy e Data safety devem refletir a versão final e todos os serviços envolvidos. Avaliar informações de conta e contato, identificadores de usuário/dispositivo/conexão, conteúdo de incidentes, ações, notificações, dados de suporte e registros operacionais. A coleta opcional de push e a finalidade de funcionalidade precisam ser declaradas conforme as definições de cada loja.

Não marcar “nenhum dado coletado” apenas por usar servidor próprio, por criptografar tokens ou por não incluir anúncios. Não afirmar “nenhum compartilhamento” sem confirmar as relações com os operadores e as exceções aplicáveis. Confirmar também SDKs, segurança em trânsito, vínculo com identidade, rastreamento, retenção e exclusão. O inventário e as fontes oficiais estão no [guia canônico](../../mobile-store-listing.md).
