'use client';

import Link from 'next/link';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ReportProblemButton } from '@/components/support/ReportProblemButton';
import { CLAIM_STATUS_LABEL, COVERAGE_LABEL, durationLabel, formatDate, formatKm, WarrantyClaimStatus } from '@/lib/warranty';

/**
 * Cartão "Garantia" da OS encerrada: decisão tomada no encerramento, prazo/km (o que ocorrer primeiro), itens cobertos
 * e ocorrências. As ocorrências são registradas e decididas no Pós-venda → Garantias.
 */
export function WarrantyCard({ os }: { os: any }) {
  if (os?.status !== 'ENCERRADA') return null;
  const w = os.warranty;
  const expired = w ? new Date(w.validUntil).getTime() < Date.now() : false;

  return (
    <Card data-testid="os-warranty-card">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-lg">
          {w ? <ShieldCheck className="h-5 w-5" aria-hidden /> : <ShieldOff className="h-5 w-5" aria-hidden />} Garantia
        </CardTitle>
        <div className="flex items-center gap-2">
          {w && <ReportProblemButton context={{ module: 'GARANTIAS', screen: `OS #${os.osNumber} → Garantia`, entityType: 'WARRANTY', entityId: w.id }} />}
          {w ? (
            <Badge variant={expired ? 'secondary' : 'success'}>{expired ? 'Prazo encerrado' : 'Dentro do prazo'}</Badge>
          ) : (
            <Badge variant="secondary">{os.warrantyDecision === 'NONE' ? 'Sem garantia' : 'Sem decisão registrada'}</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!w ? (
          <p className="text-muted-foreground">
            {os.warrantyDecision === 'NONE'
              ? 'A OS foi encerrada sem garantia.'
              : 'A OS foi encerrada sem decisão de garantia (política da empresa não exigia ou OS anterior à regra).'}
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Tipo</dt>
                <dd className="font-medium text-foreground">{COVERAGE_LABEL[w.coverage as keyof typeof COVERAGE_LABEL] ?? w.coverage}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Prazo</dt>
                <dd className="font-medium text-foreground">
                  {durationLabel(w.durationValue, w.durationUnit)}
                  {w.kmLimit ? ` ou ${formatKm(w.kmLimit)} km — o que ocorrer primeiro` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Início (entrega)</dt>
                <dd className="text-foreground">{formatDate(w.startDate)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Validade</dt>
                <dd className="text-foreground">{formatDate(w.validUntil)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Km inicial</dt>
                <dd className="text-foreground">{w.startKm != null ? `${formatKm(Number(w.startKm))} km` : '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Km limite</dt>
                <dd className="text-foreground">{w.kmUntil != null ? `${formatKm(Number(w.kmUntil))} km` : 'Sem limite de km'}</dd>
              </div>
            </dl>
            {Array.isArray(w.coveredItems) && w.coveredItems.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground">Itens cobertos</p>
                <ul className="list-disc pl-5 text-foreground">
                  {w.coveredItems.map((i: any) => (
                    <li key={i.id}>
                      {i.itemType === 'PART' ? 'Peça' : 'Serviço'}: {i.description}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {w.conditions && (
              <p>
                <span className="text-xs text-muted-foreground">Condições: </span>
                {w.conditions}
              </p>
            )}
            {w.notes && (
              <p>
                <span className="text-xs text-muted-foreground">Observações: </span>
                {w.notes}
              </p>
            )}
            <div>
              <p className="text-xs text-muted-foreground">Ocorrências</p>
              {w.claims?.length ? (
                <ul className="space-y-1">
                  {w.claims.map((c: any) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{CLAIM_STATUS_LABEL[c.status as WarrantyClaimStatus] ?? c.status}</Badge>
                      <span className="text-foreground">{c.description}</span>
                      <span className="text-xs text-muted-foreground">{formatDate(c.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">Nenhuma ocorrência registrada.</p>
              )}
            </div>
            <Link href="/dashboard/post-sale" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
              Registrar ocorrência em Pós-venda → Garantias
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}
