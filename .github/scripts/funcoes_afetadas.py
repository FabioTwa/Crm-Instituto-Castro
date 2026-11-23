#!/usr/bin/env python3
"""Lista as Edge Functions afetadas por uma lista de arquivos alterados.

Uso: python3 funcoes_afetadas.py <arquivo com caminhos alterados, um por linha>
Uma funcao e afetada se mudou algum arquivo da pasta dela ou algum arquivo de
_shared que ela importa (direta ou indiretamente). Imprime os nomes, um por linha.
"""
import os
import re
import sys

BASE = "supabase/functions"
RE_IMPORT = re.compile(r'from\s+"(\.{1,2}/[^"]+)"')


def deps(arquivo, vistos):
    arquivo = os.path.normpath(arquivo)
    if arquivo in vistos or not os.path.isfile(arquivo):
        return vistos
    vistos.add(arquivo)
    with open(arquivo, encoding="utf-8") as f:
        texto = f.read()
    for rel in RE_IMPORT.findall(texto):
        deps(os.path.join(os.path.dirname(arquivo), rel), vistos)
    return vistos


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        alterados = {os.path.normpath(l.strip()) for l in f if l.strip()}
    funcoes = sorted(
        d for d in os.listdir(BASE)
        if not d.startswith("_") and os.path.isfile(os.path.join(BASE, d, "index.ts"))
    )
    for fn in funcoes:
        pasta = os.path.normpath(os.path.join(BASE, fn)) + os.sep
        if any(a.startswith(pasta) and not a.endswith("_test.ts") for a in alterados):
            print(fn)
            continue
        usados = deps(os.path.join(BASE, fn, "index.ts"), set())
        if any(u in alterados for u in usados):
            print(fn)


if __name__ == "__main__":
    main()
