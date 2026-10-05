// Regras de handoff por CODIGO, aplicadas sobre a ultima mensagem do lead ANTES
// de qualquer chamada a IA. Resolucao CFM 2.336/2023: duvida clinica, urgencia e
// reclamacao nunca passam pela IA; vao para a equipe humana.
//
// LIMITACAO CONHECIDA: regex nao entende contexto. Ha uma guarda simples de
// negacao ("nao e urgente", "sem dor forte") que evita os falsos-positivos mais
// obvios, mas frases como "ontem tive dor forte, hoje estou bem" ainda disparam
// urgencia. Preferimos o falso-positivo (um humano olha) ao falso-negativo.
import { normalizarTexto } from "./texto.ts";

export type MotivoHandoff =
  | "duvida_clinica"
  | "urgencia"
  | "reclamacao"
  | "pedido_humano";

export type Handoff = { motivo: MotivoHandoff; termo: string; resposta_fixa: string | null };

export const RESPOSTA_URGENCIA =
  "Entendi, e sinto muito que você esteja passando por isso. Como assistente virtual não consigo avaliar situações de urgência: " +
  "se os sintomas forem intensos, procure o pronto-socorro mais próximo ou ligue 192 (SAMU) agora. " +
  "Já avisei a nossa equipe, que vai entrar em contato com você o quanto antes.";

export const RESPOSTA_DUVIDA_CLINICA =
  "Obrigado por compartilhar. Essa é uma dúvida que só a nossa equipe médica pode responder com segurança, " +
  "então vou encaminhar para que alguém te retorne por aqui. Enquanto isso, posso te ajudar com informações sobre a clínica ou agendar uma avaliação.";

export const RESPOSTA_RECLAMACAO =
  "Sinto muito pela experiência. Vou encaminhar agora para a nossa equipe, que vai te responder pessoalmente por aqui.";

export const RESPOSTA_PEDIDO_HUMANO =
  "Claro! Vou chamar alguém da nossa equipe para continuar com você por aqui. Só um momento.";

// Guarda de negacao: se logo antes do termo (ate duas palavras de distancia)
// houver "nao e", "nao esta", "nao foi", "nao tenho", "sem", "nenhum", o termo
// nao conta.
const NEGACAO = /(?:^|\s)(?:nao (?:e|eh|esta|estou|foi|tenho|tive|sinto|to)|sem|nenhum[a]?)\s+(?:\w+\s+){0,2}$/;

function ocorrenciaNaoNegada(texto: string, re: RegExp): string | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(texto)) !== null) {
    const antes = texto.slice(Math.max(0, m.index - 24), m.index);
    if (!NEGACAO.test(antes)) return m[0];
    if (m[0].length === 0) g.lastIndex++;
  }
  return null;
}

const RE_URGENCIA =
  /\b(dor forte|dor muito forte|sangramento|sangrando|vomitando sangue|vomito com sangue|desmai\w*|febre alta|emergencia|urgente|urgencia|passando mal|falta de ar|pronto socorro|pronto-socorro)\b/;

const RE_DUVIDA_CLINICA =
  /\b(posso tomar|dose|dosagem|\d+\s*mg|mg|remedio|remedios|medicamento|medicamentos|medicacao|ozempic|mounjaro|wegovy|saxenda|tirzepatida|semaglutida|liraglutida|efeito colateral|efeitos colaterais|interage|interacao|diagnostico|exame deu|resultado do exame|resultado dos exames|laudo|e grave|eh grave|sintoma|sintomas)\b/;

const RE_RECLAMACAO =
  /\b(reclamar|reclamacao|absurdo|absurda|pessimo|pessima|horrivel|procon|processar|processo judicial|advogad[oa]|insatisfeit[oa]|descaso|vergonha)\b/;

const RE_PEDIDO_HUMANO =
  /\b(falar com (?:uma |um |a |o )?(?:pessoa|atendente|humano|humana|medic[oa]|doutor|doutora|alguem)|atendente|humano|humana|alguem de verdade|robo|robos|bot|chatbot)\b/;

// Ordem importa: urgencia vence duvida clinica, que vence reclamacao, que vence
// pedido de humano. Devolve null quando nenhuma regra bate.
export function detectarHandoff(textoOriginal: string): Handoff | null {
  const t = normalizarTexto(textoOriginal);
  if (!t) return null;

  let termo = ocorrenciaNaoNegada(t, RE_URGENCIA);
  if (termo) return { motivo: "urgencia", termo, resposta_fixa: RESPOSTA_URGENCIA };

  termo = ocorrenciaNaoNegada(t, RE_DUVIDA_CLINICA);
  if (termo) return { motivo: "duvida_clinica", termo, resposta_fixa: RESPOSTA_DUVIDA_CLINICA };

  termo = ocorrenciaNaoNegada(t, RE_RECLAMACAO);
  if (termo) return { motivo: "reclamacao", termo, resposta_fixa: RESPOSTA_RECLAMACAO };

  termo = ocorrenciaNaoNegada(t, RE_PEDIDO_HUMANO);
  if (termo) return { motivo: "pedido_humano", termo, resposta_fixa: RESPOSTA_PEDIDO_HUMANO };

  return null;
}
