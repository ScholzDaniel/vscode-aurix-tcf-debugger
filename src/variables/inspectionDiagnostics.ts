import { z } from 'zod';
import type { ExpressionsContextData } from '../tcf/expressions';
import type { TCFSymbolContextData } from '../tcf/symbols';

const text = z.string().max(128);
/* eslint-disable @typescript-eslint/naming-convention -- Preserve TCF field names in diagnostic metadata. */
export const localInspectionDetailsSchema = z.object({
	stage: z.literal('local-preflight'),
	expressionId: text,
	contextId: text,
	stackId: text,
	expressionContext: z.object({
		ID: text, ParentID: text.optional(), SymbolID: text.optional(), Expression: text.optional(),
		HasFuncCall: z.boolean().optional(), CanAssign: z.boolean().optional(),
		Class: z.number().optional(), Type: text.optional(), Size: z.number().optional(),
	}).nullable(),
	symbolContext: z.object({
		ID: text, Name: text.nullable().optional(), Class: z.number(), Size: z.number().optional(),
		Address: z.number().optional(), Register: text.optional(), hasConstantValue: z.boolean(),
	}).optional(),
	truncatedFields: z.array(z.string().max(64)).max(11),
});
/* eslint-enable @typescript-eslint/naming-convention */

export class LocalInspectionError extends Error {
	readonly details: z.infer<typeof localInspectionDetailsSchema>;

	constructor(readonly code: string, message: string, contextId: string, stackId: string, expressionId: string,
		metadata: ExpressionsContextData | null, symbol?: TCFSymbolContextData) {
		super(message);
		const truncatedFields: string[] = [];
		const bounded = (field: string, value: string): string => {
			if (value.length > 128) { truncatedFields.push(field); }
			return value.slice(0, 128);
		};
		const optional = (field: string, value: string | undefined) => value === undefined ? undefined : bounded(field, value);
		/* eslint-disable @typescript-eslint/naming-convention -- TCF wire metadata, not arbitrary response properties. */
		this.details = {
			stage: 'local-preflight',
			expressionId: bounded('expressionId', expressionId),
			contextId: bounded('contextId', contextId),
			stackId: bounded('stackId', stackId),
			expressionContext: metadata === null ? null : {
				ID: bounded('expressionContext.ID', metadata.ID),
				ParentID: optional('expressionContext.ParentID', metadata.ParentID),
				SymbolID: optional('expressionContext.SymbolID', metadata.SymbolID),
				Expression: optional('expressionContext.Expression', metadata.Expression),
				HasFuncCall: metadata.HasFuncCall, CanAssign: metadata.CanAssign,
				Class: metadata.Class, Type: optional('expressionContext.Type', metadata.Type), Size: metadata.Size,
			},
			symbolContext: symbol === undefined ? undefined : {
				ID: bounded('symbolContext.ID', symbol.ID),
				Name: symbol.Name === null ? null : optional('symbolContext.Name', symbol.Name),
				Class: symbol.Class, Size: symbol.Size, Address: symbol.Address,
				Register: optional('symbolContext.Register', symbol.Register), hasConstantValue: symbol.Value !== undefined,
			},
			truncatedFields,
		};
		/* eslint-enable @typescript-eslint/naming-convention */
	}
}
