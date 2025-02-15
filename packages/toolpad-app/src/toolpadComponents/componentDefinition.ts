import { ArgTypeDefinitions } from '@mui/toolpad-core';
import * as appDom from '../appDom';
import { PropExpression, ResolvedProps } from '../types';

export interface RenderContext {
  dom: appDom.AppDom;
  addImport(source: string, imported: string, local: string): string;
  addCodeComponentImport(source: string, local: string): string;
  renderProps(resolvedProps: ResolvedProps): string;
  renderJsExpression(expr?: PropExpression): string;
  renderJsxContent(expr?: PropExpression): string;
}

export type RenderComponent = (
  ctx: RenderContext,
  node: appDom.ElementNode,
  resolvedProps: ResolvedProps,
) => string;

export interface ToolpadComponentDefinition {
  displayName: string;
  argTypes: ArgTypeDefinitions;
  importedModule: string;
  importedName: string;
  codeComponent?: boolean;
  extraControls?: Partial<Record<string, { type: string }>>;
}

export type ToolpadComponentDefinitions = Record<string, ToolpadComponentDefinition | undefined>;
export interface InstantiatedComponent extends ToolpadComponentDefinition {
  Component: React.ComponentType<any>;
}
export type InstantiatedComponents = Record<string, InstantiatedComponent | undefined>;
