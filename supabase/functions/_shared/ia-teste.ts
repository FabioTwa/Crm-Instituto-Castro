// Fase de teste/treinamento da IA de pre-atendimento (crm_ia_config):
//
//   modo_sombra   'true' (padrao) = a IA roda tudo, mas NUNCA envia ao lead;
//                 a resposta fica em ia_decisoes_log.detalhe.resposta.
//                 So 'false' libera o envio. Independe da flag
//                 envio_whatsapp_cloud_api, que continua valendo para a equipe.
//   numeros_teste lista de telefones separados por virgula, ponto e virgula ou
//                 quebra de linha. Preenchida = a IA so atende esses numeros e ignora
//                 todos os outros leads. Vazia = atende todo mundo.
//
// Assim da para treinar no numero real (coexistencia) conversando a partir de
// celulares da equipe, sem a IA falar com nenhum paciente.
import { canonicoTelefone, telefoneBrPlausivel } from "./telefone.ts";

export function numerosTeste(valor: string | null | undefined): string[] {
  const lista = String(valor || "")
    .split(/[,;\n]+/)
    .map((x) => canonicoTelefone(x))
    .filter((x) => telefoneBrPlausivel(x));
  return [...new Set(lista)];
}

export type FaseTeste = { atende: boolean; sombra: boolean; restrito: boolean };

export function faseTeste(cfg: Record<string, string>, telefoneLead: string): FaseTeste {
  const sombra = String(cfg.modo_sombra ?? "true").trim().toLowerCase() !== "false";
  const lista = numerosTeste(cfg.numeros_teste);
  const restrito = lista.length > 0;
  const atende = !restrito || lista.includes(canonicoTelefone(telefoneLead));
  return { atende, sombra, restrito };
}
