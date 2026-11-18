# Barra de navegação do celular e do tablet

Prints gerados pelo E2E (`teste/e2e-barra-celular.mjs`) no modo demonstração local, com dados fictícios.

| print | o que mostra |
|---|---|
| `01-celular-barra-pipeline.jpg` | 375 x 812, Pipeline aberto: barra com Pipeline na cor da marca |
| `02-celular-folha-mais-aberta.jpg` | folha "Mais" aberta sobre o fundo escuro, barra visível por cima |
| `03-celular-item-ativo-acoes-do-dia.jpg` | Ações do Dia aberta: o item acende |
| `04-celular-mais-ativo-usuarios.jpg` | Usuários aberta (tela de dentro do "Mais"): o "Mais" acende |
| `05-computador-sem-mudanca-1280.jpg` | 1280 x 800: menu lateral de sempre, sem barra |

Computador: o print de 1280 x 800 da tela do Pipeline ficou idêntico pixel a pixel ao da `main` antes da mudança.

## Como rodar os testes

    node teste/testar-menu.mjs
    IC_E2E_VENDOR=<pasta com playwright, @electric-sql/pglite@0.5.8, @supabase/supabase-js@2.117.2, lucide@1.52.0> \
      node teste/e2e-barra-celular.mjs celular
    IC_E2E_VENDOR=<mesma pasta> node teste/e2e-barra-celular.mjs computador
