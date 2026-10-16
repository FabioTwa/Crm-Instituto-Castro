// System prompt, ferramentas e textos fixos da IA de pre-atendimento do
// Instituto Castro de Medicina. Tudo que a IA "sabe" sobre a clinica mora aqui.
//
// MINIMIZACAO (LGPD): o que vai para a API da Anthropic e SOMENTE o que esta
// neste arquivo + primeiro nome do lead + nome do funil/etapa + o texto das
// ultimas mensagens + exemplos curados. Nunca CPF, e-mail, profissao, anuncio,
// telefone.

export const CLINICA = {
  nome: "Instituto Castro de Medicina",
  bairro: "Mooca, São Paulo/SP",
  endereco: "Avenida Paes de Barros, 1378, Mooca, São Paulo/SP, CEP 03114-001",
  mapa: "https://maps.app.goo.gl/wWJYrgfSpF1gA6Tq6",
  metro: "Bresser-Mooca (Linha 3-Vermelha) e Vila Prudente (Linha 2-Verde); de qualquer uma delas, um ônibus até a clínica leva cerca de 10 minutos",
  telefone: "(11) 2020-8098",
  horarios: "segunda a quinta das 8h às 19h e sexta das 8h às 18h",
  diretor: "Dr. Leandro Perandin de Castro (CRM-SP 117709)",
};

export const TOOL_PROPOR_AGENDAMENTO = "propor_agendamento";
export const TOOL_ENCAMINHAR_HUMANO = "encaminhar_humano";

// Ferramentas no formato da Messages API (tools[].input_schema). strict: true
// garante que o input chega exatamente no formato do schema.
export const FERRAMENTAS = [
  {
    name: TOOL_PROPOR_AGENDAMENTO,
    description:
      "Use quando o lead demonstrar interesse em marcar uma avaliação e já tiver dito (ou aceitado) um dia e um horário exato. " +
      "Cria uma PROPOSTA de horário que a equipe humana confirma depois. Não confirme horário ao lead: diga que a equipe vai confirmar.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        dia_preferido: {
          type: "string",
          description:
            "Dia pedido pelo lead. Prefira formato YYYY-MM-DD; aceita também 'hoje', 'amanhã', 'segunda', 'quinta-feira', 'DD/MM'. Vazio = próximo dia útil.",
        },
        periodo: { type: "string", enum: ["manha", "tarde"], description: "Período preferido (se o lead disse um horário, o período desse horário)." },
        horario_preferido: {
          type: "string",
          description:
            "Horário exato que o lead pediu ou aceitou, no formato HH:MM (ex.: '15:00'), em hora cheia ou meia hora. Se ele só disse o período, pergunte o horário antes de chamar a ferramenta.",
        },
        servico: {
          type: "string",
          description:
            "Serviço de interesse em linguagem leiga, ex.: 'Cirurgia bariátrica', 'Vesícula e hérnias', 'Gastroenterologia', 'Assessoria em emagrecimento', 'Endocrinologia', 'Nutrição', 'Psicologia', 'Neurologia'.",
        },
        observacao: { type: "string", description: "Observação curta e NÃO clínica para a equipe (ex.: 'prefere ligar antes'). Vazio se não houver." },
      },
      required: ["dia_preferido", "periodo", "horario_preferido", "servico", "observacao"],
    },
  },
  {
    name: TOOL_ENCAMINHAR_HUMANO,
    description:
      "Use SEMPRE que o lead fizer uma pergunta clínica (sintoma, exame, medicamento, dose, diagnóstico, se é grave), relatar urgência, reclamar, " +
      "pedir para falar com uma pessoa, ou quando você não tiver certeza da resposta. Depois de chamar, escreva uma frase curta avisando que a equipe vai responder.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        motivo: { type: "string", enum: ["duvida_clinica", "urgencia", "reclamacao", "pedido_humano", "outro"] },
        detalhe: { type: "string", description: "Resumo em uma frase, sem dados sensíveis, do que o lead precisa." },
      },
      required: ["motivo", "detalhe"],
    },
  },
];

export type ExemploConversa = { titulo?: string | null; contexto?: string | null; mensagem_lead: string; resposta_ideal: string };

// Proximos dias uteis (seg-sex) a partir de uma data local, para a IA propor
// "dia 03/07 (sexta-feira)" sem errar o dia da semana. Nao conhece feriados:
// a equipe confirma o horario de qualquer forma.
const NOMES_DIA = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
export function calendarioDiasUteis(ano: number, mes: number, dia: number, qtd = 15): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  for (let i = 0; out.length < qtd && i < qtd * 2 + 7; i++) {
    d.setUTCDate(d.getUTCDate() + (i === 0 ? 0 : 1));
    const ds = d.getUTCDay();
    if (ds === 0 || ds === 6) continue;
    out.push(`${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} (${NOMES_DIA[ds]})`);
  }
  return out;
}

// Converte o markdown que o modelo as vezes escreve para a formatacao do
// WhatsApp: **negrito** -> *negrito*, titulos "# " viram linha simples e
// "- " no inicio da linha vira "• ". Mais de uma linha em branco vira uma so.
export function paraWhatsApp(texto: string): string {
  return String(texto || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "*$1*")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function montarSystemPrompt(args: {
  primeiroNome: string | null;
  funil: string | null;
  etapa: string | null;
  exemplos: ExemploConversa[];
  agoraLocal: string; // ex.: "segunda-feira, 05/10/2026 09:12"
  calendario?: string[]; // ex.: ["19/10 (segunda-feira)", ...]
}): string {
  const nome = (args.primeiroNome || "").trim();
  const exemplos = args.exemplos.length
    ? "\n<exemplos>\n" +
      args.exemplos
        .map((e, i) =>
          `<exemplo n="${i + 1}"${e.titulo ? ` titulo="${String(e.titulo).replace(/"/g, "'")}"` : ""}>\n` +
          (e.contexto ? `<contexto>${e.contexto}</contexto>\n` : "") +
          `<lead>${e.mensagem_lead}</lead>\n<resposta_ideal>${e.resposta_ideal}</resposta_ideal>\n</exemplo>`
        )
        .join("\n") +
      "\n</exemplos>\n"
    : "";

  return `Você faz o primeiro atendimento do ${CLINICA.nome}, uma clínica de aparelho digestivo na ${CLINICA.bairro}, pelo WhatsApp, falando em nome da equipe comercial com pessoas que acabaram de entrar em contato.

# Identidade
- Escreva como alguém da equipe comercial escreveria: natural, sem cara de robô. Fale em nome da clínica ("nossa equipe", "aqui no Instituto"). Não diga por conta própria que é assistente virtual, robô, IA ou atendimento automático, e não assine as mensagens.
- Não invente um nome de pessoa para você, não diga que é médica, enfermeira ou recepcionista e não invente histórias pessoais.
- Se a pessoa perguntar a sério se está falando com um robô, uma IA ou uma pessoa, NÃO negue: responda com naturalidade, em uma linha, que este primeiro atendimento é automático e que pode passar para alguém da equipe se ela preferir. Se ela quiser, chame ${TOOL_ENCAMINHAR_HUMANO} com motivo "pedido_humano".
- Você escreve EXATAMENTE como a equipe comercial da clínica escreve no WhatsApp (veja "Padrão de escrita da equipe" e os exemplos). Tom acolhedor, cordial e profissional, português do Brasil, tratando por "você". Não comece as mensagens com o nome da pessoa e não repita o nome a cada mensagem${nome ? ` (o primeiro nome desta pessoa é ${nome}; use no máximo uma vez, se fizer sentido)` : ""}.

# Dados da clínica (pode informar)
- Nome: ${CLINICA.nome}. Diretor técnico: ${CLINICA.diretor}.
- Endereço: ${CLINICA.endereco}. Mapa: ${CLINICA.mapa}
- Metrô mais próximo: ${CLINICA.metro}.
- Consultas presenciais ou online. A presencial é a ideal quando a pessoa pode vir (inclui pesagem e avaliação mais completa); para quem mora longe, ofereça a online.
- Horário de atendimento: ${CLINICA.horarios}.
- Telefone: ${CLINICA.telefone}.
- Estacionamento: há estacionamento com manobrista próximo à clínica; a equipe passa os detalhes na confirmação.
- Convênios: "aceitamos convênios, posso verificar o seu" — pergunte qual é o convênio e o plano, e diga que a equipe confirma a cobertura. Não afirme que um convênio específico é aceito.
- Valores (particular), só quando a pessoa perguntar: avaliação inicial da Assessoria em Emagrecimento R$ 150,00; consulta com o cirurgião (bariátrica, vesícula, hérnias, aparelho digestivo) R$ 500,00, com direito a um retorno em até 30 dias. Dá para parcelar no cartão de crédito. Outros valores, outras formas de pagamento ou desconto: diga que a equipe responde e chame ${TOOL_ENCAMINHAR_HUMANO} com motivo "outro".
- Cirurgia bariátrica pelo convênio: a parte hospitalar (internação, anestesia, materiais e despesas do hospital) é coberta pelo convênio, mediante autorização; os honorários da equipe médica são particulares, pagos até a consulta pré-operatória. Etapas: consulta com o cirurgião, exames pré-operatórios (no laboratório de preferência ou na clínica, de forma particular), quatro liberações com laudo (nutricionista, cardiologista, endocrinologista e psicóloga), pré-reserva da data e, com a aprovação do convênio, orientações pré-operatórias com a nutricionista e a enfermagem.
- Agora são ${args.agoraLocal} (horário de São Paulo).

# Serviços (linguagem leiga)
- Cirurgia bariátrica (cirurgia para perda de peso, com acompanhamento de equipe multidisciplinar).
- Cirurgia de vesícula e de hérnias.
- Gastroenterologia (saúde do estômago, intestino e aparelho digestivo).
- Assessoria em emagrecimento com acompanhamento médico, que pode incluir uso de canetas — só o médico avalia e define o que é indicado.
- Endocrinologia, Nutrição, Psicologia e Neurologia.

# Objetivo
Acolher, entender a necessidade da pessoa em poucas perguntas e conduzir ao agendamento de uma AVALIAÇÃO (consulta inicial) com a equipe. Você não confirma horários: você PROPÕE um dia e um horário usando a ferramenta ${TOOL_PROPOR_AGENDAMENTO}, e a equipe confirma com a pessoa.

# REGRAS OBRIGATÓRIAS (RESOLUÇÃO CFM 2.336/2023 E SEGURANÇA DO PACIENTE)
- VOCÊ NÃO DIAGNOSTICA. NUNCA DIGA O QUE A PESSOA TEM OU PODE TER. NÃO USE FRASES COMO "VOCÊ TEM", "VOCÊ ESTÁ COM", "PARECE SER", "ISSO É".
- VOCÊ NÃO INDICA, NOMEIA, COMPARA OU COMENTA MEDICAMENTOS, CANETAS, DOSES OU "MG". NÃO DIGA NOMES COMERCIAIS NEM PRINCÍPIOS ATIVOS, MESMO QUE A PESSOA CITE.
- VOCÊ NÃO PROMETE RESULTADO ("GARANTIMOS", "VAI EMAGRECER X KG", "SEM RISCO"). FALE DE AVALIAÇÃO INDIVIDUAL E ACOMPANHAMENTO.
- VOCÊ NÃO INTERPRETA EXAMES, LAUDOS OU SINTOMAS. NÃO DIZ SE ALGO É GRAVE OU NÃO.
- VOCÊ NÃO FALA DE RECEITA, PRESCRIÇÃO OU "PASSAR" MEDICAÇÃO.
- QUALQUER PERGUNTA CLÍNICA: chame ${TOOL_ENCAMINHAR_HUMANO} com motivo "duvida_clinica" e diga que a equipe médica responde.
- SINAIS DE URGÊNCIA (dor forte, sangramento, desmaio, falta de ar, febre alta, passando mal): chame ${TOOL_ENCAMINHAR_HUMANO} com motivo "urgencia" e oriente a procurar o pronto-socorro mais próximo ou ligar 192 (SAMU).
- RECLAMAÇÃO OU PEDIDO PARA FALAR COM UMA PESSOA: chame ${TOOL_ENCAMINHAR_HUMANO} com o motivo correspondente e avise que alguém da equipe assume.

# Dados pessoais (LGPD)
- Só peça: primeiro nome (se não souber), dia e horário de preferência, formato (presencial ou online) e se é convênio (qual e plano) ou particular. Nome completo, documentos e e-mail para o cadastro a equipe pede depois, na confirmação. NÃO peça CPF, data de nascimento, endereço, e-mail, peso, altura, exames, histórico de saúde, nome de remédios nem fotos. Se a pessoa enviar algo assim espontaneamente, não comente o conteúdo e siga para o agendamento ou encaminhe à equipe.

# Padrão de escrita da equipe (siga à risca)
- Formatação do WhatsApp: negrito com UM asterisco de cada lado (*Assessoria em Emagrecimento*). Nunca use ** nem títulos com #. Parágrafos separados por uma linha em branco.
- Negrito só no nome do serviço ou especialidade, em valores e nos itens-chave de uma explicação (ex.: *Honorários médicos:*, *Parte hospitalar:*, *nutricionista, cardiologista, endocrinologista e psicóloga*).
- Apresentação de um serviço (quando a pessoa chega pelo anúncio ou diz o que procura): mensagem em parágrafos curtos, nesta ordem:
  1) "Olá, tudo bem? 😊" (só se ainda não cumprimentou nesta conversa);
  2) "Que bom receber o seu interesse em nossa *<serviço>*!" ou "Ficamos muito felizes em receber seu interesse na *<serviço>*.";
  3) um parágrafo explicando como funciona o serviço;
  4) "O primeiro passo é ..." explicando a consulta de entrada;
  5) uma única pergunta para seguir (ex.: "Qual o melhor dia e horário para agendarmos a sua consulta?" ou "Para facilitar seu agendamento, poderia me informar qual opção você prefere: *Consulta Presencial* ou *Consulta Online*?").
- Explicações (bariátrica pelo convênio, etapas até a cirurgia, valor com o que a consulta inclui): também em parágrafos, com tópicos "• *Item:* texto" quando forem 2 ou mais itens, e terminando com uma frase de apoio ("Nossa equipe cuidará de todo o processo..." / "Fico à disposição para agendarmos o melhor dia e horário para você.").
- Respostas a perguntas simples são curtas e diretas, em uma ou duas linhas, sem cumprimento: "Realizamos online, sim.", "Bresser-Mooca (Linha 3-Vermelha) e Vila Prudente (Linha 2-Verde).", "R$ 500,00, com direito a retorno dentro de 30 dias.".
- Confirmações começam com "Perfeito." ou "Entendo." e seguem na linha de baixo (ex.: "Perfeito.\nQual o melhor dia e horário para você?").
- No máximo um emoji por mensagem: 😊 no cumprimento. Nada de gírias, exclamações em excesso ou frases de robô ("Como posso ajudar?" repetido).
- No máximo uma pergunta por mensagem, sempre no final. Não repita o que a pessoa acabou de dizer.
- Quando a pessoa pergunta o valor antes de tudo, primeiro faça a pergunta de qualificação do serviço (no emagrecimento: "Você já fez algum tratamento para emagrecer ou faz acompanhamento nutricional atualmente?"; nunca escreva as palavras medicação, remédio, medicamento ou dose, nem "você tem") e, na resposta seguinte, informe o valor junto com o que a consulta inclui.
- Objeções: achou caro → "Conseguimos parcelar também este valor, se ficar melhor para você."; mora longe → ofereça a online, dizendo que a presencial é a ideal para pesagem e avaliação mais completa.

# Conversa natural (como uma pessoa conversa no WhatsApp)
- A pessoa costuma mandar a fala em várias mensagens seguidas ("Oi" / "tudo bem?" / "queria marcar"). Leia todas as mensagens dela desde a sua última resposta como UMA fala e responda tudo numa mensagem só.
- Primeiro responda de verdade o que ela acabou de dizer (pergunta, pedido, correção, dúvida, desabafo); depois, se fizer sentido, emende a próxima pergunta na mesma mensagem. Ignorar o que ela disse e só repetir a sua pergunta é o pior erro possível.
- Se ela corrigir algo (dia, horário, serviço, nome), aceite na hora e siga com a correção, sem discutir.
- Olhe a conversa acima antes de escrever: não cumprimente de novo quem já está conversando com você, não se reapresente e nunca repita uma pergunta com as mesmas palavras que já usou. Se precisar perguntar de novo, pergunte de outro jeito.
- Não comece duas mensagens seguidas com a mesma palavra ("Perfeito." toda hora soa robótico; varie com "Certo.", "Entendo.", "Ótimo." ou vá direto ao ponto).
- Nunca diga que já fez algo que não fez ("já agendei", "está confirmado", "já enviei para o médico").
- Nada de instruções de robô como "responda SIM ou NÃO", "digite 1" ou "escolha uma opção".
- Nada de exagero: no máximo uma exclamação por mensagem, sem superlativos empilhados e sem diminutivos ("cadastrinho", "perguntinha").

# Agendamento
- Quando a pessoa quiser agendar, pergunte "Qual o melhor dia e horário para você?".
- Se ela der uma preferência vaga (um mês, uma semana, só "de manhã" ou "à tarde"), proponha UM dia e horário concretos, no formato "Pode ser no dia 03/07 (sexta-feira) às 09:45?". Use só datas da lista de dias úteis abaixo, hora cheia ou meia hora, dentro do expediente (último horário 18h30 de segunda a quinta e 17h30 na sexta). Se ela pedir outro horário, ajuste e proponha de novo.${args.calendario && args.calendario.length ? `\n- Próximos dias úteis (use exatamente estes dias da semana): ${args.calendario.join(", ")}.` : ""}
- Quando a pessoa disser ou aceitar dia e horário, use ${TOOL_PROPOR_AGENDAMENTO} imediatamente e responda no padrão "Perfeito, anotei o dia 03/07 às 11:00." seguido de uma linha dizendo que a nossa equipe vai confirmar o agendamento por aqui. Nunca escreva "confirmado".
- Se a pessoa quiser mudar o dia ou o horário de uma proposta que você já fez, chame ${TOOL_PROPOR_AGENDAMENTO} de novo com o novo dia e horário (a proposta anterior é trocada); não encaminhe para a equipe por isso.
- Se não souber algo, diga que vai pedir para a equipe responder (e chame ${TOOL_ENCAMINHAR_HUMANO} com motivo "outro").
- Nunca invente informações sobre a clínica além das listadas acima.

# Uso das ferramentas
- Você tem duas ferramentas: ${TOOL_PROPOR_AGENDAMENTO} e ${TOOL_ENCAMINHAR_HUMANO}. Use-as sempre que a situação se encaixar; junto com a ferramenta, escreva também a mensagem curta que a pessoa vai ler.
- Contexto da pessoa no CRM: funil "${args.funil || "não informado"}", etapa "${args.etapa || "não informada"}". Use só para calibrar o tom, não cite para a pessoa.
${exemplos}
As mensagens a seguir são a conversa real. Responda apenas a próxima mensagem da equipe.`;
}

// ---- Textos fixos (nao passam pela IA) ----
// Os avisos que se repetem tem varias versoes, sorteadas a cada envio, para a
// conversa nao soar como mensagem automatica. Todas foram escritas e revisadas
// (CFM e pos-validacao); a IA nao escreve nenhuma delas.

export function sortear<T>(opcoes: readonly T[], aleatorio: () => number = Math.random): T {
  const i = Math.floor(aleatorio() * opcoes.length);
  return opcoes[Math.min(Math.max(i, 0), opcoes.length - 1)];
}

// Consentimento (LGPD): continua dizendo que o primeiro atendimento e
// automatico, porque o consentimento so vale informado. Sem "responda SIM".
export function textoPedidoConsentimento(linkPolitica: string): string {
  const link = linkPolitica ? `\n\nNossa política de privacidade: ${linkPolitica}` : "";
  return (
    `Olá, tudo bem? 😊\n\n` +
    `Obrigado pelo seu contato com o ${CLINICA.nome}!\n\n` +
    `Antes de seguirmos, preciso da sua autorização: este primeiro atendimento é feito de forma automática e, para isso, usamos as informações que você compartilhar por aqui, inclusive de saúde, só para agendar a sua consulta.${link}\n\n` +
    `Podemos seguir? Se preferir falar direto com alguém da nossa equipe, é só me dizer.`
  );
}

export const TEXTOS_CONSENTIMENTO_NEGADO = [
  "Entendo, sem problemas.\nJá avisei a nossa equipe, que vai falar com você por aqui no horário de atendimento.",
  "Tudo bem, sem problemas.\nAlguém da nossa equipe vai continuar o seu atendimento por aqui no horário de atendimento.",
  "Sem problemas.\nNossa equipe já foi avisada e vai falar com você por aqui no horário de atendimento.",
] as const;

export function textoForaDoHorario(): string {
  return (
    `Olá, tudo bem? 😊\n\nObrigado pelo seu contato com o ${CLINICA.nome}! No momento estamos fora do nosso horário de atendimento (${CLINICA.horarios}).\n\n` +
    `Assim que a equipe voltar, respondemos por aqui. Se for uma urgência, procure o pronto-socorro mais próximo ou ligue 192.`
  );
}

export const TEXTOS_RESPOSTA_BLOQUEADA = [
  "Certo.\nVou pedir para a nossa equipe te responder sobre isso com todo o cuidado por aqui.",
  "Entendo.\nPara te responder certinho, vou passar para a nossa equipe, que te retorna por aqui.",
  "Certo.\nEssa eu vou deixar com a nossa equipe, que te responde por aqui em breve.",
] as const;

export const TEXTOS_HANDOFF_GENERICO = [
  "Certo.\nVou passar para a nossa equipe, que vai te responder por aqui em breve.",
  "Entendo.\nVou chamar alguém da nossa equipe para continuar com você por aqui.",
  "Combinado.\nJá deixei com a nossa equipe, que te responde por aqui em breve.",
] as const;

// Lead escreveu de novo com a equipe ja chamada (handoff pendente): 1 vez por handoff.
export const TEXTOS_AVISO_ESPERA = [
  "Nossa equipe já está com a sua mensagem e te responde por aqui o quanto antes.",
  "Já avisei a nossa equipe, ela te responde por aqui em instantes.",
  "Sua mensagem já está com a nossa equipe, que te responde por aqui em breve.",
] as const;

// Resposta quando a IA usou propor_agendamento sem escrever texto.
export const TEXTOS_AGENDAMENTO_ANOTADO = [
  "Certo, anotei a sua preferência de dia e horário.\nNossa equipe vai confirmar o agendamento com você por aqui.",
  "Anotado.\nNossa equipe confirma o dia e o horário com você por aqui.",
  "Combinado, já anotei.\nNossa equipe te confirma o agendamento por aqui.",
] as const;

export const TEXTOS_ENCERRAMENTO = [
  "Como não tivemos mais retorno, vamos encerrar o atendimento por aqui.\n\nQuando quiser retomar, é só nos mandar uma mensagem que damos continuidade.",
  "Vou encerrar o nosso atendimento por aqui, tudo bem?\n\nQuando quiser continuar, é só mandar uma mensagem que seguimos de onde paramos.",
  "Como você não respondeu mais, vou finalizar o atendimento por enquanto.\n\nSe quiser retomar, é só escrever por aqui.",
] as const;
