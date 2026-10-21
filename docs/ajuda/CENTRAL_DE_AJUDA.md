# Central de Ajuda da loja — artigos operacionais

> Texto para quem usa o CÓRTEX no balcão, no caixa, na oficina e na gerência. **Não é documentação técnica** (essa fica em `docs/CORTEX`) e não traz nada restrito ao Super Admin. Cada bloco `<!-- artigo ... -->` vira um artigo da Central de Ajuda (Super Admin → Suporte → Base de conhecimento) pelo comando `npm run help:seed` (`apps/api`). Escreva só o que o sistema faz hoje.

<!-- artigo: slug=entrar-e-recuperar-acesso | modulo=USUARIOS | titulo=Entrar no sistema e recuperar o acesso | resumo=Como entrar, o que fazer se esquecer a senha ou a conta bloquear | palavras=login senha bloqueio mfa esqueci -->
## Como entrar

- **Admin Web e Super Admin:** e-mail e senha.
- **PDV e Balcão:** o seu número de identificação (ID) e a senha. Cada pessoa usa o **próprio** acesso — nunca use o de um colega.
- Se a sua conta usa a **verificação em duas etapas**, depois da senha digite o código de 6 dígitos do aplicativo autenticador. Cada código vale **uma vez**: se o sistema disser que o código já foi utilizado, espere o aplicativo mostrar o próximo.

## Administrador da empresa: verificação em duas etapas obrigatória

Em produção, quem é **administrador da empresa** precisa da verificação em duas etapas. No **primeiro acesso** o Admin Web mostra uma tela para ativá-la: escaneie o QR code com um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy…), digite o código de 6 dígitos e **guarde os códigos de recuperação** que aparecem (eles são mostrados uma única vez). Ative logo depois de receber a conta.

- **Perdi o celular:** na tela do código escolha *Perdi o aplicativo: usar um código de recuperação* e digite um dos códigos guardados (cada um vale uma vez). Sem os códigos, peça à equipe de suporte da plataforma para **reiniciar** a sua verificação; você terá de configurá-la de novo.
- Quem tem um perfil que exige a verificação **não consegue desativá-la**.
- Se mudarem o seu perfil de acesso, você precisará entrar de novo.

## Esqueci a senha

O CÓRTEX **não envia link de recuperação**. Peça ao **administrador da sua empresa** para redefinir a senha em *Usuários*. Depois de redefinida, entre com a senha nova e troque-a.

## Conta bloqueada

Depois de algumas tentativas erradas a conta é bloqueada por um tempo, para proteger você. Aguarde o prazo informado na tela ou peça ao administrador para **desbloquear** em *Usuários*.

## Ao sair

No PDV e no Balcão, **fechar a janela ou sair da conta encerra a sua sessão**; ao reabrir é preciso entrar de novo. Sair **não fecha o caixa**.
<!-- /artigo -->

<!-- artigo: slug=perfis-e-permissoes | modulo=USUARIOS | titulo=Perfis e permissões: o que cada pessoa pode fazer | resumo=O que significa a mensagem de falta de autorização e como pedir acesso | palavras=permissão perfil acesso negado autorização administrador -->
## Cada pessoa tem o acesso da sua função

O administrador da empresa define o que cada usuário pode fazer (por exemplo: atender no balcão, operar o caixa, cadastrar produtos, consultar relatórios). Isso vale para todas as telas e também para o que o sistema aceita por trás delas.

## "Usuário sem autorização. Entre em contato com o administrador."

Significa que você entrou corretamente, mas a **sua função não inclui** aquela ação. Não é falha do sistema. Peça ao administrador para conferir o seu perfil em *Usuários → Perfis*.

## Quem vê custos

O **custo** do produto e margens aparecem só para quem tem função de gestão ou perfil de compras. Atendentes e mecânicos veem o preço de venda.

## Perfis só de consulta

Quem tem perfil de **consulta** vê as informações, mas não altera nada.
<!-- /artigo -->

<!-- artigo: slug=cadastrar-e-editar-produtos | modulo=ESTOQUE | titulo=Cadastrar e editar produtos | resumo=Campos do produto, SKU e o que não muda quando você edita | palavras=produto cadastro sku preço categoria desativar -->
## Cadastro

Em *Produtos → Novo produto* informe nome, **SKU**, preço de venda, custo, unidade e categoria. O **SKU é único na sua empresa**: o sistema recusa repetir.

## Editar

Pode mudar nome, preço, categoria e demais campos. O produto continua **o mesmo** para o histórico — vendas, estoque, compras e ordens de serviço anteriores não se perdem.

## Desativar em vez de apagar

Produto que não é mais vendido deve ser **desativado**. Ele sai das buscas de venda, mas o histórico permanece.

## Imagem (opcional)

Na edição do produto (*Produtos → abrir o produto*) o cartão **Imagem do produto (opcional)** permite enviar uma foto **PNG, JPEG ou WebP de até 1 MB**. O produto funciona igual sem imagem, e a importação por planilha não usa imagem. Ao guardar, o sistema confere o arquivo de verdade e **remove os dados de localização e do aparelho** que a foto tenha. Para trocar, envie outra; para tirar, use *Remover*. Só gerência e administrador enviam ou removem imagem. O PDV e o Balcão ainda **não exibem** a imagem.
<!-- /artigo -->

<!-- artigo: slug=codigos-de-barras | modulo=ESTOQUE | titulo=Códigos de barras: vários por produto | resumo=Como adicionar, trocar e desativar códigos e o que fazer quando o sistema recusa | palavras=código de barras ean leitor duplicado ambíguo zero -->
## Vários códigos para o mesmo produto

Um produto pode ter **mais de um** código de barras (por exemplo, embalagens ou fornecedores diferentes). Em *Produtos → editar produto → Códigos de barras* você adiciona, desativa e reativa.

## Regras

- Cada código identifica **um único produto** na empresa. Se tentar usar um código que já é de outro produto, o sistema avisa qual é e **não grava**.
- Os códigos são **texto**: os zeros à esquerda (`0001234567890`) são mantidos e fazem parte do código.
- **Desativar** tira o código da leitura, mas guarda o histórico. O produto (SKU) continua o mesmo.

## "Este código identifica mais de um produto ativo"

Acontece quando o mesmo código ficou cadastrado em dois produtos antigos. O sistema **não escolhe um deles** — para vender com segurança, a gerência precisa corrigir o cadastro (desativar o código num dos produtos). Enquanto isso, busque o produto pelo nome.

## Leitor de código

O leitor funciona como um teclado: clique no campo de busca e leia. Se o código não for encontrado, confira se o produto está **ativo** e se o código foi cadastrado.
<!-- /artigo -->

<!-- artigo: slug=importar-produtos-por-planilha | modulo=ESTOQUE | titulo=Importar produtos por planilha | resumo=Formato, prévia, erros por linha e cuidados com códigos de barras | palavras=importar planilha excel csv produtos prévia erro -->
## Formato

Aceita **CSV** (separador `;` ou `,`) e **Excel (.xlsx)**. Colunas: SKU, nome, preço (obrigatórias), e opcionais como custo, código de barras, categoria e estoque inicial.

## Antes de importar: prévia

A tela mostra uma **prévia**: quantas linhas serão criadas, atualizadas ou recusadas e o motivo de cada recusa. Nada é gravado até você confirmar.

## O que é recusado

- SKU repetido na própria planilha.
- Código de barras que **já pertence a outro produto**.
- Preço ou quantidade inválidos.

As linhas boas são importadas; as recusadas aparecem com o número da linha e o motivo. Corrija e importe de novo — repetir a mesma planilha **não duplica** produtos (o SKU identifica o produto).

## Cuidado com zeros à esquerda

No Excel, formate a coluna de código de barras como **Texto** antes de digitar. Se a coluna estiver como número, o Excel apaga os zeros à esquerda antes de o CÓRTEX receber.

## Quem pode

Importar exige permissão própria (normalmente administrador). Fica registrado quem importou e quando.
<!-- /artigo -->

<!-- artigo: slug=vender-e-receber-pagamentos | modulo=PDV | titulo=Vender e receber pagamentos | resumo=Formas de pagamento, maquininha, parcelas e o que é registro manual | palavras=venda pagamento cartão pix dinheiro parcelas maquininha -->
## Formas de pagamento

Dinheiro, débito, crédito, PIX e convênio (quando habilitado pela empresa).

## Cartão: a maquininha é independente

O CÓRTEX **ainda não conversa com a maquininha**. O operador passa o cartão na maquininha e, se aprovado, **confirma no PDV**. O sistema registra o que você confirmou; ele não vê a aprovação do banco. Por isso, **só confirme se a maquininha aprovou**.

## PIX

Fica **aguardando confirmação**: a venda só é concluída quando o pagamento for confirmado.

## Parcelamento

O número máximo de parcelas é definido pela empresa por forma de pagamento (sem regra definida, só à vista). O CÓRTEX divide o valor em centavos exatos (a diferença de centavos vai nas últimas parcelas). **Ele não calcula juros.**

## Clicou duas vezes?

O sistema protege contra cobrança duplicada: a mesma venda não é lançada duas vezes.

## Sem internet

Venda e pagamento **não** são guardados para depois: sem conexão a operação **não é concluída** e o sistema avisa.
<!-- /artigo -->

<!-- artigo: slug=caixa-abrir-e-fechar | modulo=PDV | titulo=Caixa: abrir, movimentar e fechar | resumo=Abertura, sangria, reforço, fechamento e a diferença entre sair e fechar o caixa | palavras=caixa abertura fechamento sangria reforço conferência -->
## Abrir

Em *Caixa → Abrir caixa* informe o **número do caixa** (cada computador da loja usa um número) e o valor inicial.

## Durante o dia

Registre **sangria** (retirada) e **reforço** (entrada) com o motivo. Tudo fica registrado com quem fez.

## Fechar

*Caixa → Fechar caixa*: o sistema mostra o esperado por forma de pagamento; você confere e informa o contado. Diferenças ficam registradas.

## Sair da conta não é fechar o caixa

Sair da conta, bloquear a tela ou fechar a janela **não fecham o caixa**. O fechamento é uma operação própria, feita na tela *Caixa*.

## Bloquear a tela

*Bloquear tela* protege o PDV quando você se afasta: nada fica disponível até você digitar a **sua senha**. A venda em andamento continua.
<!-- /artigo -->

<!-- artigo: slug=estoque-saldo-e-disponivel | modulo=ESTOQUE | titulo=Estoque: saldo, disponível, transferências e devoluções | resumo=A diferença entre saldo e disponível e como movimentar o estoque | palavras=estoque saldo disponível reserva transferência devolução -->
## Saldo e disponível

- **Saldo**: o que existe fisicamente, calculado pelas movimentações.
- **Disponível**: o saldo menos o que está **reservado** (por exemplo, pedidos de canais de venda). É o número que vale para vender.

## Movimentações

Entradas, saídas, ajustes e transferências ficam **todas registradas** (quem, quando, motivo). O histórico não é apagado.

## Transferência entre filiais

Saem de uma filial e entram na outra; não é possível transferir mais do que existe.

## Devolução

Devoluções de venda repõem o estoque e ficam rastreadas; devolução ao fornecedor exige aprovação da gerência.
<!-- /artigo -->

<!-- artigo: slug=oficina-orcamento-e-ordem-de-servico | modulo=OFICINA | titulo=Oficina: do orçamento à ordem de serviço | resumo=Fluxo cliente, veículo, orçamento, aprovação, OS e encaminhamento ao caixa | palavras=oficina orçamento ordem de serviço os balcão aprovação -->
## Fluxo

1. **Cliente** e **veículo** (cadastre se for novo).
2. **Orçamento** com peças (o sistema mostra o disponível) e serviços.
3. **Enviar** ao cliente e registrar a **decisão** (aprovou/recusou). Mudou o orçamento? Cria-se uma **nova versão**; as anteriores ficam guardadas.
4. **Abrir a ordem de serviço** (informe a quilometragem de entrada).
5. Execução, pagamento e entrega.

## Encaminhar ao caixa

O Balcão **não cobra**. A *ficha de encaminhamento* leva ao caixa o resumo e o **total calculado pelo sistema**; o pagamento é feito no PDV.

## Um orçamento aberto por veículo

Se já existe um orçamento em aberto para o veículo, o sistema oferece abrir o existente.
<!-- /artigo -->

<!-- artigo: slug=mensagens-de-erro-comuns | modulo=OUTRO | titulo=Mensagens de erro comuns e o que fazer | resumo=Significado das mensagens mais frequentes e a ação recomendada | palavras=erro mensagem 403 409 conexão equipamento autorização -->
| Mensagem | O que significa | O que fazer |
|---|---|---|
| Usuário sem autorização | Sua função não inclui a ação | Falar com o administrador |
| Este código de barras já pertence ao produto… | O código é de outro produto | Corrigir o cadastro do outro produto ou usar outro código |
| Este código identifica mais de um produto ativo | Código repetido em dois produtos antigos | Gerência corrige o cadastro |
| Sem conexão com o servidor — a operação NÃO foi concluída | A internet ou o servidor caiu | Verificar a rede e repetir; **não** presuma que foi vendido |
| Dispositivo aguardando autorização | O computador ainda não foi liberado | Informar o código de conferência ao suporte da plataforma |
| Muitas tentativas | Limite de segurança | Aguardar o tempo informado |
| Módulo não habilitado | A empresa não tem este módulo | Falar com o administrador |
| Não foi possível verificar a sessão agora | O sistema não conseguiu confirmar a sua sessão (instabilidade momentânea) — você **não** foi desconectado | Aguardar alguns segundos e repetir |
| Código já utilizado | O código do aplicativo autenticador só vale uma vez | Esperar o aplicativo mostrar o próximo código |
| Sua conta exige a verificação em duas etapas | Perfil de administrador sem o aplicativo configurado | Configurar na tela que aparece (veja *Entrar no sistema*) |
| Este perfil exige a verificação em duas etapas e ela não pode ser desativada | Perfil de administrador | Em caso de perda do aplicativo, pedir a reinicialização ao suporte da plataforma |
| Formato não aceito. Envie uma imagem PNG, JPEG ou WebP | Imagem do produto em outro formato (SVG, GIF, PDF…) | Converter para PNG, JPEG ou WebP |
| A imagem passa de 1 MB | Arquivo grande demais | Reduzir a imagem |
| Não é possível anonimizar agora | Há cobrança, venda ou ordem de serviço em aberto | Resolver a pendência e repetir o pedido |
<!-- /artigo -->

<!-- artigo: slug=computador-do-pdv-e-conexao | modulo=PDV | titulo=Computador do PDV: instalação, liberação e conexão | resumo=O que é preciso para o PDV funcionar e como o computador é liberado | palavras=instalação pdv equipamento autorização conexão https -->
## Liberação do computador

Na primeira abertura o PDV se **registra** e mostra um **código de conferência**. A equipe de suporte da plataforma confere o código e **vincula o computador à sua empresa e filial**. Só depois o login é liberado.

## Conexão

O PDV precisa de **internet estável** para vender, receber e fechar o caixa. O endereço do servidor é definido na instalação e não pode ser alterado pelo operador.

## Várias pessoas, um computador

Cada operador entra com o **próprio** acesso. Ao trocar de operador: *Sair da conta*. O PDV e o Balcão podem estar no mesmo computador; as sessões são separadas.
<!-- /artigo -->

<!-- artigo: slug=privacidade-dados-dos-clientes | modulo=CONFIGURACOES | titulo=Privacidade: os dados dos seus clientes | resumo=Responsabilidades da loja e como tratar pedidos de titulares de dados | palavras=lgpd privacidade dados pessoais titular cliente -->
## Quem é responsável

Os dados de **clientes e veículos** cadastrados pela sua loja são tratados **por conta da sua empresa** (controladora, nos termos da LGPD). O CÓRTEX os trata para prestar o serviço (operadora).

## Boas práticas

- Cadastre **só o necessário** (nome basta para atender no balcão).
- Dê acesso só a quem precisa e **desative** quem saiu da empresa.
- Não compartilhe a sua senha e **bloqueie a tela** ao se afastar.
- Não envie dados de clientes por canais não autorizados.

## Pedidos de titulares

Se um cliente pedir uma cópia dos próprios dados ou a anonimização do cadastro, **o administrador da empresa** atende em *Privacidade (LGPD)* no menu do Admin Web (só ele vê essa tela):

1. Busque o cliente (nome, CPF/CNPJ ou e-mail) e **confirme a identidade de quem pediu** antes de qualquer coisa.
2. Escreva a **justificativa** (por exemplo, o protocolo do pedido — **sem dados pessoais no texto**) e digite a **sua senha**.
3. **Exportar:** o sistema gera um arquivo (JSON) só com os dados daquele cliente e baixa na hora. Ele fica disponível por **24 horas, até 3 downloads**; depois é apagado do sistema.
4. **Anonimizar:** primeiro o sistema **mostra o que muda e o que precisa ser mantido**; só depois de você confirmar (com a senha) ele sobrescreve o cadastro. **Não dá para desfazer.** Valores, datas e números de vendas e do financeiro continuam; o nome e o CPF/CNPJ ficam enquanto houver **documento fiscal recente** (obrigação legal), e a anonimização é **bloqueada** se o cliente tiver cobrança, venda ou ordem de serviço em aberto.

O resultado pode ser *Concluído*, *Concluído em parte* (algo precisou ser mantido) ou *Bloqueado* — a tela diz o motivo, e é isso que você deve explicar ao cliente. A trilha de auditoria, as cópias de segurança e as tentativas de cobrança já registradas **não são alteradas**. Se precisar de apoio técnico, **abra um chamado** descrevendo o pedido, sem copiar dados pessoais no texto.
<!-- /artigo -->

<!-- artigo: slug=como-abrir-chamado-de-suporte | modulo=OUTRO | titulo=Como abrir um chamado de suporte | resumo=Passo a passo para pedir ajuda com as informações certas | palavras=suporte chamado ajuda problema relatar -->
## Pelo próprio sistema

Use o botão **Relatar problema** (no PDV e nas telas do Admin Web). O sistema já anexa o contexto da tela (módulo, tela e versão).

## O que escrever

- O que você estava fazendo e o que esperava.
- O que aconteceu (copie a mensagem exibida).
- Se foi uma venda ou pagamento, o horário aproximado.

## O que **não** enviar

Senhas, códigos de verificação, números completos de cartão e dados pessoais desnecessários.

## Acompanhar

Em *Ajuda → Chamados* você vê as respostas e pode complementar.
<!-- /artigo -->
