#!/usr/bin/env python3
"""Robo do Support Clinic: exporta o Relatorio de agendamentos e manda ao CRM.

Roda no GitHub (workflow .github/workflows/support-clinic.yml), uma vez por dia.
Faz SO isto, devagar, como uma pessoa faria:
  1. abre a tela de login e entra com o usuario do IC (o mesmo da equipe; sessao propria do robo);
  2. abre Relatorios > Agenda > Relatorio de agendamentos;
  3. preenche o periodo (do dia 1 do mes atual ao ultimo dia do mes seguinte);
  4. clica em "Gerar relatorio" e depois em "Excel";
  5. abre a tela do chamado de suporte (SC_CHAMADO_ID) e SO LE o status, a
     ultima atualizacao e a ultima parte da conversa (nao digita nem clica);
  6. sai do sistema (Sair);
  7. le o Excel, manda ao CRM so as colunas necessarias (sem o nome do
     paciente) e apaga o arquivo; manda o status do chamado.
Nao clica em mais nada. Se a leitura do chamado falhar, a exportacao segue
normalmente (o chamado e so informativo). Se qualquer tela estiver diferente do esperado, se o
login falhar ou se aparecer captcha/codigo de verificacao, PARA na hora, nao
tenta de novo e avisa o Fabio por WhatsApp (via funcao ic-supportclinic).

Variaveis de ambiente (segredos do GitHub):
  SC_USUARIO, SC_SENHA     login do usuario do IC no Support Clinic (o mesmo da equipe)
  SC_IMPORT_TOKEN          token da funcao ic-supportclinic
  SC_FUNCAO_URL            URL da funcao (nao e segredo)
  SC_CHAMADO_ID            numero do chamado a acompanhar (opcional; vazio = nao le)
Nada de paciente e impresso no log: so contagens.
"""
import calendar
import datetime as dt
import json
import os
import random
import shutil
import sys
import tempfile
import time
import unicodedata
import urllib.request
from zoneinfo import ZoneInfo

BASE = "https://app.supportclinic.com.br"
URL_LOGIN = BASE + "/login"
URL_RELATORIO = BASE + "/atendimento/agendar-atendimentos/agendamento/relatorios"
URL_SAIR = BASE + "/logout"
URL_CHAMADO = BASE + "/chamados/{}"
FUSO = ZoneInfo("America/Sao_Paulo")

# Colunas do Excel conferidas em 25/11/2026. Se mudarem, o robo para.
COLUNAS = [
    "Código", "Paciente", "Telefone", "Origem", "Orçamento", "Data", "Agendamento",
    "Sala", "Leito", "Profissional", "Agendado por", "Status", "Data da criação",
]
# O que vai ao CRM (o nome do paciente NAO vai).
ENVIAR = {
    "codigo": "Código", "telefone": "Telefone", "data": "Data", "tipo": "Agendamento",
    "profissional": "Profissional", "agendado_por": "Agendado por", "status": "Status",
    "criado": "Data da criação",
}


class Parada(Exception):
    """Falha esperada: para o robo e avisa. etapa = chave do aviso."""

    def __init__(self, etapa, motivo):
        super().__init__(motivo)
        self.etapa = etapa
        self.motivo = motivo


def log(msg):
    agora = dt.datetime.now(FUSO).strftime("%H:%M:%S")
    print(f"[{agora}] {msg}", flush=True)


def pausa(minimo=3.0, maximo=8.0):
    time.sleep(random.uniform(minimo, maximo))


def olhar(pagina, minimo, maximo):
    """Fica na tela como quem le: mexe o mouse e rola um pouco, devagar.
    So movimento e rolagem; nunca clica."""
    fim = time.monotonic() + random.uniform(minimo, maximo)
    while time.monotonic() < fim:
        try:
            acao = random.random()
            if acao < 0.55:
                pagina.mouse.move(random.randint(120, 1240), random.randint(120, 700),
                                  steps=random.randint(8, 30))
            elif acao < 0.85:
                pagina.mouse.wheel(0, random.choice([1, 1, -1]) * random.randint(80, 360))
        except Exception:
            pass
        time.sleep(min(random.uniform(1.5, 6.0), max(0.0, fim - time.monotonic())))


def digitar(pagina, seletor, texto):
    """Clica no campo, limpa e digita letra por letra, com ritmo variavel."""
    campo = pagina.locator(seletor)
    campo.click()
    time.sleep(random.uniform(0.8, 2.0))
    campo.press("Control+a")
    campo.press("Backspace")
    for letra in texto:
        pagina.keyboard.type(letra)
        time.sleep(random.uniform(0.12, 0.38))
    time.sleep(random.uniform(1.0, 2.5))


def sem_acento(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").lower()


def periodo_hoje():
    hoje = dt.datetime.now(FUSO).date()
    ini = hoje.replace(day=1)
    ano, mes = (hoje.year + 1, 1) if hoje.month == 12 else (hoje.year, hoje.month + 1)
    fim = dt.date(ano, mes, calendar.monthrange(ano, mes)[1])
    return ini, fim


def chamar_funcao(corpo):
    url = os.environ["SC_FUNCAO_URL"]
    dados = json.dumps(corpo, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=dados, method="POST", headers={
        "Content-Type": "application/json",
        "x-sc-token": os.environ["SC_IMPORT_TOKEN"],
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def avisar_falha(etapa, motivo):
    try:
        r = chamar_funcao({"acao": "falha", "etapa": etapa, "motivo": motivo})
        log(f"aviso de falha enviado: {r.get('enviado')}")
    except Exception as e:  # o aviso nao pode derrubar a saida do robo
        log(f"nao consegui avisar a falha: {type(e).__name__}")


def conferir_sem_bloqueio(pagina, etapa):
    """Captcha ou verificacao em duas etapas: o robo nao tenta passar."""
    sinais = pagina.locator(
        "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], "
        "[class*='captcha'], [id*='captcha'], input[name*='code'], input[name*='otp'], input[name*='token2fa']"
    )
    if sinais.count() > 0:
        raise Parada(etapa, "apareceu captcha ou código de verificação; o robô parou sem tentar passar")


def entrar(pagina):
    pagina.goto(URL_LOGIN, wait_until="domcontentloaded")
    olhar(pagina, 8, 18)
    if "/login" not in pagina.url or pagina.locator("input[name='email']").count() != 1:
        raise Parada("login", "a tela de login está diferente do esperado")
    conferir_sem_bloqueio(pagina, "login")
    digitar(pagina, "input[name='email']", os.environ["SC_USUARIO"])
    pausa(3, 7)
    digitar(pagina, "input[name='password']", os.environ["SC_SENHA"])
    pausa(3, 8)
    pagina.locator("form[action$='/login'] button[type='submit']").click()
    pagina.wait_for_load_state("domcontentloaded")
    pausa(5, 10)
    conferir_sem_bloqueio(pagina, "login")
    if "/login" in pagina.url:
        raise Parada("login", "o Support Clinic recusou o login (usuário ou senha, ou acesso bloqueado)")
    log("login ok")
    olhar(pagina, 30, 75)  # tela inicial, como quem chega no sistema


def titulo(pagina):
    return pagina.get_by_role("heading", name="Relatório de agendamentos", exact=True)


def preencher_data(pagina, seletor, valor):
    digitar(pagina, seletor, valor)
    # Fecha o calendario clicando no titulo do relatorio, como uma pessoa faria
    # (Enter nao: enviaria o formulario).
    titulo(pagina).click()
    time.sleep(random.uniform(1.5, 3.5))
    atual = pagina.locator(seletor).input_value()
    if atual != valor:
        raise Parada("periodo", f"o campo de data ficou com outro valor ({atual or 'vazio'})")


def exportar(pagina, pasta):
    pausa(4, 10)
    pagina.goto(URL_RELATORIO, wait_until="domcontentloaded")
    olhar(pagina, 15, 35)
    if titulo(pagina).count() != 1 or pagina.locator("#input-start").count() != 1:
        raise Parada("relatorio", "a tela do relatório está diferente do esperado (ou o usuário não tem acesso)")
    conferir_sem_bloqueio(pagina, "relatorio")

    ini, fim = periodo_hoje()
    preencher_data(pagina, "#input-start", ini.strftime("%d/%m/%Y"))
    pausa(4, 9)
    preencher_data(pagina, "#input-end", fim.strftime("%d/%m/%Y"))
    pausa(6, 14)

    gerar = pagina.locator("button.btn-search")
    if gerar.count() != 1:
        raise Parada("relatorio", "não achei o botão Gerar relatório")
    gerar.click()
    try:
        pagina.wait_for_function(
            "() => { const e = document.querySelector('.dataTables_info'); return e && /\\d/.test(e.textContent || ''); }",
            timeout=90000,
        )
    except Exception:
        raise Parada("relatorio", "o relatório não carregou em 90 segundos")
    olhar(pagina, 45, 100)  # confere a lista antes de exportar

    botao = pagina.locator("button.buttons-excel")
    if botao.count() != 1:
        raise Parada("exportar", "não achei o botão Excel")
    try:
        with pagina.expect_download(timeout=180000) as baixando:
            botao.click()
        arquivo = os.path.join(pasta, "agendamentos.xlsx")
        baixando.value.save_as(arquivo)
    except Parada:
        raise
    except Exception:
        raise Parada("exportar", "o Excel não foi baixado em 3 minutos")
    log("excel baixado")
    olhar(pagina, 20, 45)
    return arquivo, ini, fim


def ler_chamado(pagina):
    """So le a tela do chamado. Nunca digita, nunca clica. Erro aqui nao para o robo."""
    numero = (os.environ.get("SC_CHAMADO_ID") or "").strip()
    if not numero.isdigit():
        return None
    try:
        pausa(6, 14)
        pagina.goto(URL_CHAMADO.format(numero), wait_until="domcontentloaded")
        olhar(pagina, 10, 20)
        if pagina.locator(".ticket-meta").count() < 1:  # a tela tem 2 blocos
            log("chamado: tela diferente do esperado; pulei")
            return None
        conferir_sem_bloqueio(pagina, "relatorio")
        cab = pagina.locator(".content-wrapper .panel").first
        titulo_cab = cab.locator(".panel-heading, .panel-title").first.inner_text().strip()
        codigo = titulo_cab.split("\n")[0].replace("Chamado", "").strip()[:20]
        status = cab.locator(".label").first.inner_text().strip()
        meta = {}
        for bloco in pagina.locator(".ticket-meta > div").all():
            rot = bloco.locator(".ticket-meta-label")
            val = bloco.locator(".ticket-meta-value")
            if rot.count() and val.count():
                meta[sem_acento(rot.first.inner_text().strip())] = val.first.inner_text().strip()
        respostas, resumo = 0, ""
        conversa = pagina.locator(".content-wrapper .panel").filter(
            has=pagina.locator(".panel-heading", has_text="Conversa"))
        if conversa.count() and conversa.first.locator(".comment-empty").count() == 0:
            corpo = conversa.first.locator(".panel-body").first
            texto = " ".join(corpo.inner_text().split())
            respostas = max(1, corpo.locator("[class*='comment']").count())
            resumo = texto[-300:]
        olhar(pagina, 25, 60)  # lendo o chamado
        log(f"chamado {codigo}: {status}, respostas: {respostas}")
        return {
            "acao": "chamado",
            "chamado": codigo or ("#" + numero),
            "status": status,
            "ultima_atualizacao": meta.get("ultima atualizacao", ""),
            "respostas": respostas,
            "resumo": resumo,
        }
    except Parada:
        raise
    except Exception as e:
        log(f"chamado: nao consegui ler ({type(e).__name__}); segue a exportacao")
        return None


def sair(pagina):
    try:
        pausa(8, 20)
        pagina.goto(URL_SAIR, wait_until="domcontentloaded")
        log("saiu do sistema")
    except Exception:
        log("nao consegui sair (a sessao expira sozinha)")


def ler_excel(arquivo):
    import openpyxl

    try:
        wb = openpyxl.load_workbook(arquivo, read_only=True, data_only=True)
        linhas = list(wb.active.iter_rows(values_only=True))
        wb.close()
    except Exception:
        raise Parada("planilha", "não consegui abrir o Excel baixado")
    if not linhas:
        raise Parada("planilha", "o Excel veio vazio")
    cab = [str(c or "").strip() for c in linhas[0]]
    if [sem_acento(c) for c in cab[: len(COLUNAS)]] != [sem_acento(c) for c in COLUNAS]:
        raise Parada("planilha", "as colunas do Excel mudaram; o robô parou para não gravar errado")
    idx = {c: i for i, c in enumerate(cab)}
    saida = []
    for linha in linhas[1:]:
        if not linha or all(v in (None, "") for v in linha):
            continue
        item = {}
        for chave, coluna in ENVIAR.items():
            v = linha[idx[coluna]] if idx[coluna] < len(linha) else None
            item[chave] = "" if v is None else str(v).strip()
        if item["codigo"] and item["status"]:
            saida.append(item)
    return saida


def main():
    for nome in ("SC_USUARIO", "SC_SENHA", "SC_IMPORT_TOKEN", "SC_FUNCAO_URL"):
        if not os.environ.get(nome):
            print(f"Falta o segredo {nome}.", flush=True)
            return 1

    from playwright.sync_api import sync_playwright

    pasta = tempfile.mkdtemp(prefix="sc-")
    try:
        with sync_playwright() as p:
            navegador = p.chromium.launch(headless=True)
            contexto = navegador.new_context(
                locale="pt-BR",
                timezone_id="America/Sao_Paulo",
                viewport={"width": 1366, "height": 768},
                accept_downloads=True,
            )
            pagina = contexto.new_page()
            pagina.set_default_timeout(45000)
            logado = False
            chamado = None
            try:
                entrar(pagina)
                logado = True
                arquivo, ini, fim = exportar(pagina, pasta)
                chamado = ler_chamado(pagina)
            finally:
                if logado:
                    sair(pagina)
                contexto.close()
                navegador.close()

        linhas = ler_excel(arquivo)
        os.remove(arquivo)  # o arquivo nao fica guardado em lugar nenhum
        if not linhas:
            raise Parada("planilha", "o relatório veio sem nenhum agendamento")
        log(f"linhas lidas: {len(linhas)}")
        try:
            r = chamar_funcao({
                "acao": "importar",
                "periodo": {"ini": ini.isoformat(), "fim": fim.isoformat()},
                "linhas": linhas,
            })
        except Exception as e:
            raise Parada("envio", f"o CRM não recebeu o relatório ({type(e).__name__})")
        if not r.get("ok"):
            raise Parada("importacao", f"o CRM recusou o relatório ({r.get('erro', 'sem detalhe')})")
        log("crm: " + json.dumps({k: r.get(k) for k in ("linhas", "casados", "movidos", "voltaram", "ignorado")}))
        if chamado:
            try:
                rc = chamar_funcao(chamado)
                log(f"status do chamado gravado: {rc.get('ok')}")
            except Exception as e:  # informativo: nao derruba a importacao
                log(f"status do chamado nao gravado ({type(e).__name__})")
        return 0
    except Parada as e:
        log(f"PAROU na etapa {e.etapa}: {e.motivo}")
        avisar_falha(e.etapa, e.motivo)
        return 2
    except Exception as e:
        log(f"erro inesperado: {type(e).__name__}")
        avisar_falha("robo", f"erro inesperado ({type(e).__name__})")
        return 3
    finally:
        shutil.rmtree(pasta, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
