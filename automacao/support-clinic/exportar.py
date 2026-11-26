#!/usr/bin/env python3
"""Robo do Support Clinic: exporta o Relatorio de agendamentos e manda ao CRM.

Roda no GitHub (workflow .github/workflows/support-clinic.yml), uma vez por dia.
Faz SO isto, devagar, como uma pessoa faria:
  1. abre a tela de login e entra com o usuario dedicado do IC;
  2. abre Relatorios > Agenda > Relatorio de agendamentos;
  3. preenche o periodo (do dia 1 do mes atual ao ultimo dia do mes seguinte);
  4. clica em "Gerar relatorio" e depois em "Excel";
  5. sai do sistema (Sair);
  6. le o Excel, manda ao CRM so as colunas necessarias (sem o nome do
     paciente) e apaga o arquivo.
Nao clica em mais nada. Se qualquer tela estiver diferente do esperado, se o
login falhar ou se aparecer captcha/codigo de verificacao, PARA na hora, nao
tenta de novo e avisa o Fabio por WhatsApp (via funcao ic-supportclinic).

Variaveis de ambiente (segredos do GitHub):
  SC_USUARIO, SC_SENHA     login do usuario dedicado do IC no Support Clinic
  SC_IMPORT_TOKEN          token da funcao ic-supportclinic
  SC_FUNCAO_URL            URL da funcao (nao e segredo)
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


def digitar(pagina, seletor, texto):
    """Clica no campo, limpa e digita letra por letra, com ritmo variavel."""
    campo = pagina.locator(seletor)
    campo.click()
    time.sleep(random.uniform(0.4, 1.0))
    campo.press("Control+a")
    campo.press("Backspace")
    for letra in texto:
        pagina.keyboard.type(letra)
        time.sleep(random.uniform(0.08, 0.22))
    time.sleep(random.uniform(0.5, 1.2))


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
    pausa(4, 9)
    if "/login" not in pagina.url or pagina.locator("input[name='email']").count() != 1:
        raise Parada("login", "a tela de login está diferente do esperado")
    conferir_sem_bloqueio(pagina, "login")
    digitar(pagina, "input[name='email']", os.environ["SC_USUARIO"])
    pausa(1.5, 3.5)
    digitar(pagina, "input[name='password']", os.environ["SC_SENHA"])
    pausa(2, 4)
    pagina.locator("form[action$='/login'] button[type='submit']").click()
    pagina.wait_for_load_state("domcontentloaded")
    pausa(4, 8)
    conferir_sem_bloqueio(pagina, "login")
    if "/login" in pagina.url:
        raise Parada("login", "o Support Clinic recusou o login (usuário ou senha, ou acesso bloqueado)")
    log("login ok")


def titulo(pagina):
    return pagina.get_by_role("heading", name="Relatório de agendamentos", exact=True)


def preencher_data(pagina, seletor, valor):
    digitar(pagina, seletor, valor)
    # Fecha o calendario clicando no titulo do relatorio, como uma pessoa faria
    # (Enter nao: enviaria o formulario).
    titulo(pagina).click()
    time.sleep(random.uniform(0.8, 1.6))
    atual = pagina.locator(seletor).input_value()
    if atual != valor:
        raise Parada("periodo", f"o campo de data ficou com outro valor ({atual or 'vazio'})")


def exportar(pagina, pasta):
    pausa(3, 7)
    pagina.goto(URL_RELATORIO, wait_until="domcontentloaded")
    pausa(4, 9)
    if titulo(pagina).count() != 1 or pagina.locator("#input-start").count() != 1:
        raise Parada("relatorio", "a tela do relatório está diferente do esperado (ou o usuário não tem acesso)")
    conferir_sem_bloqueio(pagina, "relatorio")

    ini, fim = periodo_hoje()
    preencher_data(pagina, "#input-start", ini.strftime("%d/%m/%Y"))
    pausa(1.5, 3.5)
    preencher_data(pagina, "#input-end", fim.strftime("%d/%m/%Y"))
    pausa(2, 5)

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
    pausa(4, 9)

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
    return arquivo, ini, fim


def sair(pagina):
    try:
        pausa(3, 7)
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
            try:
                entrar(pagina)
                logado = True
                arquivo, ini, fim = exportar(pagina, pasta)
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
