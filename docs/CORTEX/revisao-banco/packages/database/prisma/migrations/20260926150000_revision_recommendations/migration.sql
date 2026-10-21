-- Recomendação ao cliente registrada na revisão (o que fazer/observar até a próxima). Revisões antigas ficam nulas.
ALTER TABLE "revisions" ADD COLUMN "recommendations" TEXT;
