import { ArgTypeDefinition, ArgTypeDefinitions, PropValueTypes } from '@mui/toolpad-core';
import Imports from './codeGen/Imports';
import Scope from './codeGen/Scope';
import { getToolpadComponent, getToolpadComponents } from './toolpadComponents';
import * as appDom from './appDom';
import {
  NodeId,
  PropExpression,
  ResolvedProps,
  BindableAttrValue,
  BindableAttrValues,
  VersionOrPreview,
} from './types';
import { camelCase } from './utils/strings';
import { ExactEntriesOf } from './utils/types';
import * as bindings from './utils/bindings';
import { getQueryNodeArgTypes } from './toolpadDataSources/client';
import { tryFormat } from './utils/prettier';
import { RenderContext, ToolpadComponentDefinition } from './toolpadComponents/componentDefinition';

function argTypesToPropValueTypes(argTypes: ArgTypeDefinitions): PropValueTypes {
  return Object.fromEntries(
    Object.entries(argTypes).flatMap(([propName, argType]) =>
      argType ? [[propName, argType.typeDef]] : [],
    ),
  );
}

function propValueTypesToArgTypes(propTypes: PropValueTypes): ArgTypeDefinitions {
  return Object.fromEntries(
    Object.entries(propTypes).flatMap(([propName, typeDef]) =>
      typeDef ? [[propName, { typeDef }]] : [],
    ),
  );
}

export interface RenderPageConfig {
  // whether we're in the context of an editor
  editor: boolean;
  // prettify output
  pretty: boolean;
  // release version
  version: VersionOrPreview;
}

interface UrlQueryStateHook {
  paramName: string;
  stateVar: string;
  setStateVar: string;
  defaultValue?: PropExpression;
}

interface ControlledStateHook {
  nodeName: string;
  propName: string;
  stateVar: string;
  setStateVar: string;
  defaultValue?: PropExpression;
}

interface StateHook {
  type: 'derived' | 'api' | 'fetched';
  nodeId: NodeId;
  nodeName: string;
  stateVar: string;
  setStateVar: string;
}

interface MemoizedConst {
  varName: string;
  value: string;
}

class Context implements RenderContext {
  appId: string;

  dom: appDom.AppDom;

  private config: RenderPageConfig;

  private page: appDom.PageNode;

  private imports: Imports;

  private codeComponentImports = new Map<string, string>();

  private moduleScope: Scope;

  private reactAlias: string = 'undefined';

  private runtimeAlias: string = 'undefined';

  private urlQueryStateHooks = new Map<string, UrlQueryStateHook>();

  private controlledStateHooks = new Map<string, ControlledStateHook>();

  private pageStateIdentifier = 'undefined';

  private bindingsStateIdentifier = 'undefined';

  private stateHooks = new Map<string, StateHook>();

  private memoizedConsts: MemoizedConst[] = [];

  constructor(appId: string, dom: appDom.AppDom, page: appDom.PageNode, config: RenderPageConfig) {
    this.appId = appId;
    this.dom = dom;
    this.page = page;
    this.config = config;

    this.moduleScope = new Scope(null);

    this.imports = new Imports(this.moduleScope);

    this.reactAlias = this.addImport('react', '*', 'React');

    if (this.config.editor) {
      this.runtimeAlias = this.addImport('@mui/toolpad-core/runtime', '*', '__editorRuntime');
    }
  }

  generateControlledStateVars(...parts: string[]) {
    const stateVarSuggestion = camelCase(...parts);
    const stateVar = this.moduleScope.createUniqueBinding(stateVarSuggestion);
    const setStateVarSuggestion = camelCase('set', ...parts);
    const setStateVar = this.moduleScope.createUniqueBinding(setStateVarSuggestion);
    return [stateVar, setStateVar];
  }

  collectAllState() {
    const nodes = appDom.getDescendants(this.dom, this.page);
    nodes.forEach((node) => {
      if (appDom.isElement(node)) {
        this.collectControlledStateProps(node);
      } else if (appDom.isDerivedState(node) || appDom.isQueryState(node)) {
        this.collectStateNode(node);
      }
    });

    Object.entries(this.page.attributes.urlQuery.value || {}).forEach(
      ([paramName, defaultValue]) => {
        const [stateVar, setStateVar] = this.generateControlledStateVars(paramName);

        this.urlQueryStateHooks.set(`${this.page.id}.urlQuery.${paramName}`, {
          paramName,
          stateVar,
          setStateVar,
          defaultValue: { type: 'expression', value: JSON.stringify(defaultValue) },
        });
      },
    );
  }

  collectStateNode(node: appDom.DerivedStateNode | appDom.QueryStateNode): StateHook {
    let stateHook = this.stateHooks.get(node.id);
    if (!stateHook) {
      const stateVar = this.moduleScope.createUniqueBinding(node.name);
      const setStateVar = this.moduleScope.createUniqueBinding(camelCase('set', node.name));
      if (appDom.isDerivedState(node)) {
        stateHook = {
          type: 'derived',
          nodeId: node.id,
          nodeName: node.name,
          stateVar,
          setStateVar,
        };
        this.stateHooks.set(node.id, stateHook);
      } else if (appDom.isQueryState(node)) {
        stateHook = {
          type: 'api',
          nodeId: node.id,
          nodeName: node.name,
          stateVar,
          setStateVar,
        };
        this.stateHooks.set(node.id, stateHook);
      } else {
        throw new Error(`Invariant: Invalid node type "${(node as appDom.AppDomNode).type}"`);
      }
    }
    return stateHook;
  }

  getToolpadComponent(node: appDom.ElementNode) {
    const components = getToolpadComponents(this.appId, this.config.version, this.dom);
    return getToolpadComponent(components, node.attributes.component.value);
  }

  collectControlledStateProp(node: appDom.ElementNode, propName: string): ControlledStateHook {
    const nodeId = node.id;
    const nodeName = node.name;
    const stateId = `${nodeId}.props.${propName}`;

    let stateHook = this.controlledStateHooks.get(stateId);
    if (!stateHook) {
      const component = this.getToolpadComponent(node);

      const argType = component.argTypes[propName];

      if (!argType) {
        throw new Error(`Can't find argType for "${node.name}.${propName}"`);
      }

      if (!argType.onChangeProp) {
        throw new Error(`"${node.name}.${propName}" is not a controlled property`);
      }

      const [stateVar, setStateVar] = this.generateControlledStateVars(nodeName, propName);

      const componentLocalName = this.importComponent(component);

      const propValue = node.props?.[propName];

      const defaultValue: PropExpression =
        propValue?.type === 'const'
          ? {
              type: 'expression',
              value: JSON.stringify(propValue.value),
            }
          : {
              type: 'expression',
              value: `${componentLocalName}.defaultProps?.${propName}`,
            };

      stateHook = {
        nodeName,
        propName,
        stateVar,
        setStateVar,
        defaultValue,
      };
      this.controlledStateHooks.set(stateId, stateHook);
    }

    return stateHook;
  }

  collectControlledStateProps(node: appDom.ElementNode): void {
    const component = this.getToolpadComponent(node);

    // eslint-disable-next-line no-restricted-syntax
    for (const [propName, argType] of Object.entries(component.argTypes)) {
      if (argType?.onChangeProp) {
        this.collectControlledStateProp(node, propName);
      }
    }
  }

  evalExpression(id: string, expression: string): string {
    const evalCodeId = this.addImport('@mui/toolpad-core', 'evalCode', 'evalCode');
    const evaluated = `${evalCodeId}(${JSON.stringify(expression.trim())}, ${
      this.pageStateIdentifier
    })`;

    return this.config.editor
      ? `
        (() => {
          let error, value
          try {
            value = ${evaluated};
            return value;
          } catch (_error) {
            error = _error;
            return undefined;
          } finally {
            ${this.bindingsStateIdentifier}[${JSON.stringify(id)}] = { error, value };
          }
        })()
      `
      : `
        (() => {
          try {
            return ${evaluated};
          } catch (_error) {
            return undefined;
          }
        })()
      `;
  }

  resolveBindable<P extends appDom.BindableProps<P>>(
    id: string,
    propValue: BindableAttrValue<any>,
    argType: ArgTypeDefinition,
  ): PropExpression {
    if (propValue.type === 'const') {
      let value = JSON.stringify(propValue.value);

      if (argType.memoize) {
        const varName = this.moduleScope.createUniqueBinding('memo');
        this.memoizedConsts.push({ varName, value });
        value = varName;
      }

      return {
        type: 'expression',
        value,
      };
    }

    if (propValue.type === 'boundExpression') {
      const parsedExpr = bindings.parse(propValue.value);

      // Resolve each named variable to its resolved variable in code
      const resolvedExpr = bindings.resolve(parsedExpr, (part) => `state.${part}`);

      const formatted = bindings.formatExpression(resolvedExpr, propValue.format);

      return {
        type: 'expression',
        value: this.evalExpression(id, formatted),
      };
    }

    if (propValue.type === 'binding') {
      return {
        type: 'expression',
        value: this.evalExpression(id, `state.${propValue.value}`),
      };
    }

    if (propValue.type === 'jsExpression') {
      return {
        type: 'expression',
        value: this.evalExpression(id, propValue.value),
      };
    }

    console.warn(`Invariant: Unkown prop type "${(propValue as any).type}"`);
    return {
      type: 'expression',
      value: JSON.stringify(undefined),
    };
  }

  /**
   * Resolves BindableAttrValues to expressions we can render in the code.
   */
  resolveBindables(
    id: string,
    bindables: BindableAttrValues<any>,
    argTypes: ArgTypeDefinitions,
  ): ResolvedProps {
    const result: ResolvedProps = {};

    Object.entries(bindables).forEach(([propName, propValue]) => {
      const argType = argTypes[propName as string];
      if (propValue && argType) {
        const resolved = this.resolveBindable(`${id}.${propName}`, propValue, argType);
        if (resolved) {
          result[propName] = resolved;
        }
      }
    });

    return result;
  }

  resolveElementProps(node: appDom.ElementNode): ResolvedProps {
    const component = this.getToolpadComponent(node);

    const result: ResolvedProps = this.resolveBindables(
      `${node.id}.props`,
      node.props ?? {},
      component.argTypes,
    );

    // useState Hooks
    if (component) {
      Object.entries(component.argTypes).forEach(([propName, argType]) => {
        if (!argType) {
          return;
        }

        const stateId = `${node.id}.props.${propName}`;
        const hook = this.controlledStateHooks.get(stateId);

        if (!hook) {
          return;
        }

        result[propName] = {
          type: 'expression',
          value: hook.stateVar,
        };

        if (argType.onChangeProp) {
          if (argType.onChangeHandler) {
            // TODO: React.useCallback for this?
            const { params, valueGetter } = argType.onChangeHandler;
            result[argType.onChangeProp] = {
              type: 'expression',
              value: `(${params.join(', ')}) => ${hook.setStateVar}(${valueGetter})`,
            };
          } else {
            result[argType.onChangeProp] = {
              type: 'expression',
              value: hook.setStateVar,
            };
          }
        }
      });
    }

    return result;
  }

  resolveElementChildren(
    renderableNodeChildren: { [key: string]: appDom.ElementNode<any>[] },
    argTypes?: ArgTypeDefinitions,
  ): ResolvedProps {
    const result: ResolvedProps = {};

    // eslint-disable-next-line no-restricted-syntax
    for (const [prop, children] of Object.entries(renderableNodeChildren)) {
      if (children) {
        if (children.length === 1) {
          result[prop] = this.renderElement(children[0]);
        } else if (children.length > 1) {
          result[prop] = {
            type: 'jsxFragment',
            value: children
              .map((child): string => this.renderJsxContent(this.renderElement(child)))
              .join('\n'),
          };
        }
      }
    }

    if (this.config.editor && argTypes) {
      // eslint-disable-next-line no-restricted-syntax
      for (const [prop, argType] of Object.entries(argTypes)) {
        if (argType?.typeDef.type === 'element') {
          if (argType.control?.type === 'slots') {
            const existingProp = result[prop];

            result[prop] = {
              type: 'jsxElement',
              value: `
                <${this.runtimeAlias}.Slots prop=${JSON.stringify(prop)}>
                  ${existingProp ? this.renderJsxContent(existingProp) : ''}
                </${this.runtimeAlias}.Slots>
              `,
            };
          } else if (argType.control?.type === 'slot') {
            const existingProp = result[prop];

            result[prop] = {
              type: 'jsxElement',
              value: `
                <${this.runtimeAlias}.Placeholder prop=${JSON.stringify(prop)}>
                  ${existingProp ? this.renderJsxContent(existingProp) : ''}
                </${this.runtimeAlias}.Placeholder>
              `,
            };
          }
        }
      }
    }

    return result;
  }

  wrapComponent(node: appDom.ElementNode | appDom.PageNode, rendered: string): PropExpression {
    return {
      type: 'jsxElement',
      value: this.config.editor
        ? `
          <${this.runtimeAlias}.NodeRuntimeWrapper nodeId="${node.id}">
            ${rendered}
          </${this.runtimeAlias}.NodeRuntimeWrapper>
        `
        : rendered,
    };
  }

  importComponent(component: ToolpadComponentDefinition): string {
    const localName = component.codeComponent
      ? this.addCodeComponentImport(component.importedModule, component.importedName)
      : this.addImport(component.importedModule, component.importedName);
    return localName;
  }

  renderElement(node: appDom.ElementNode): PropExpression {
    const component = this.getToolpadComponent(node);

    const resolvedProps = this.resolveElementProps(node);
    const resolvedChildren = this.resolveElementChildren(
      appDom.getChildNodes(this.dom, node),
      component.argTypes,
    );

    const renderedProps = this.renderProps({
      ...resolvedProps,
      ...resolvedChildren,
    });

    const localName = this.importComponent(component);
    const rendered = `<${localName} ${renderedProps} />`;

    return this.wrapComponent(node, rendered);
  }

  /**
   * Renders a node to a string that can be inlined as the return value of a React component
   * @example
   * `function Hello () {
   *   return ${RESULT};
   * }`
   */
  renderRoot(node: appDom.PageNode): string {
    const { children } = appDom.getChildNodes(this.dom, node);
    const resolvedChildren = this.resolveElementChildren(
      { children },
      {
        children: {
          typeDef: { type: 'element' },
          control: { type: 'slots' },
        },
      },
    );

    const Stack = this.addImport('@mui/material', 'Stack', 'Stack');

    const rendered = `
      <${Stack} direction="column" alignItems='stretch' sx={{ my: 2 }}>
        ${this.renderJsxContent(resolvedChildren.children)}
      </${Stack}>
    `;

    // const rendered = this.renderJsExpression(resolvedChildren.children);
    const expr = this.wrapComponent(node, rendered);
    return this.renderJsExpression(expr);
  }

  /**
   * Renders resolved properties to a string that can be inlined as JSX attrinutes
   * @example `<Hello ${RESULT} />`
   */
  renderProps(resolvedProps: ResolvedProps): string {
    return (Object.entries(resolvedProps) as ExactEntriesOf<ResolvedProps>)
      .map(([name, expr]) => {
        if (!expr) {
          return '';
        }
        return `${name}={${this.renderJsExpression(expr)}}`;
      })
      .join(' ');
  }

  /**
   * Renders resolved properties to a string that can be inlined as a JS object
   * @example
   *     `const hello = ${RESULT}`;
   *     // "const hello = { foo: 'bar' }"
   */
  renderPropsAsObject(resolvedProps: ResolvedProps): string {
    const keyValuePairs = (Object.entries(resolvedProps) as ExactEntriesOf<ResolvedProps>).map(
      ([name, expr]) => {
        if (!expr) {
          return '';
        }
        const renderedExpression = this.renderJsExpression(expr);
        return name === renderedExpression ? name : `${name}: ${renderedExpression}`;
      },
    );
    return `{${keyValuePairs.join(', ')}}`;
  }

  /**
   * Renders an expression to a string that can be used as a javascript
   * expression. e.g. as the RHS of an assignment statement
   * @example `const hello = ${RESULT}`
   */
  // eslint-disable-next-line class-methods-use-this
  renderJsExpression(expr?: PropExpression): string {
    if (!expr) {
      return 'undefined';
    }
    if (expr.type === 'jsxFragment') {
      return `<>${expr.value}</>`;
    }
    return expr.value;
  }

  /**
   * Renders an expression to a string that can be inlined as children in
   * a JSX element.
   * @example `<Hello>${RESULT}</Hello>`
   */
  renderJsxContent(expr?: PropExpression): string {
    if (!expr) {
      return '';
    }
    if (expr.type === 'jsxElement' || expr.type === 'jsxFragment') {
      return expr.value;
    }
    return `{${this.renderJsExpression(expr)}}`;
  }

  /**
   * Adds an import to the page module. Returns an identifier that's based on [suggestedName] that can
   * be used to reference the import.
   */
  addImport(
    source: string,
    imported: '*' | 'default' | string,
    suggestedName: string = imported,
  ): string {
    return this.imports.add(source, imported, suggestedName);
  }

  addCodeComponentImport(source: string, suggestedName: string = 'CodeComponent'): string {
    if (this.config.editor) {
      const existing = this.codeComponentImports.get(source);
      if (existing) {
        return existing;
      }

      const varName = this.moduleScope.createUniqueBinding(suggestedName);
      this.codeComponentImports.set(source, varName);
      return varName;
    }

    return this.imports.add(source, 'default', suggestedName);
  }

  renderCodeComponentImports(): string {
    // TODO: Import concurrently through Promise.all
    return Array.from(
      this.codeComponentImports.entries(),
      ([source, name]) =>
        `const ${name} = await ${this.runtimeAlias}.importCodeComponent(import(${JSON.stringify(
          source,
        )}))`,
    ).join('\n');
  }

  renderControlledStateHooks(): string {
    return Array.from(this.controlledStateHooks.values(), (stateHook) => {
      const defaultValue = this.renderJsExpression(stateHook.defaultValue);
      return `const [${stateHook.stateVar}, ${stateHook.setStateVar}] = ${this.reactAlias}.useState(${defaultValue});`;
    }).join('\n');
  }

  renderUrlQueryStateHooks(): string {
    return Array.from(this.urlQueryStateHooks.values(), (stateHook) => {
      const useUrlQueryState = this.addImport(
        '@mui/toolpad-core',
        'useUrlQueryState',
        'useUrlQueryState',
      );
      const paramName = JSON.stringify(stateHook.paramName);
      const defaultValue = this.renderJsExpression(stateHook.defaultValue);
      return `const [${stateHook.stateVar}, ${stateHook.setStateVar}] = ${useUrlQueryState}(${paramName}, ${defaultValue});`;
    }).join('\n');
  }

  renderDataQueryState(): string {
    return Array.from(this.stateHooks.values(), (hook) => {
      if (hook.type === 'derived') {
        return `const [${hook.stateVar}, ${hook.setStateVar}] = React.useState();`;
      }
      const INITIAL_DATA_QUERY = this.addImport(
        '@mui/toolpad-core',
        'INITIAL_DATA_QUERY',
        'INITIAL_DATA_QUERY',
      );
      return `const [${hook.stateVar}, ${hook.setStateVar}] = React.useState(${INITIAL_DATA_QUERY});`;
    }).join('\n');
  }

  renderStateHooks(): string {
    return Array.from(this.stateHooks.values(), (stateHook) => {
      switch (stateHook.type) {
        case 'derived': {
          const node = appDom.getNode(this.dom, stateHook.nodeId, 'derivedState');
          const resolvedParams = this.resolveBindables(
            `${node.id}.params`,
            node.params ?? {},
            propValueTypesToArgTypes(node.attributes.argTypes.value),
          );
          const paramsArg = this.renderPropsAsObject(resolvedParams);
          const depsArray = Object.values(resolvedParams).map((resolvedProp) =>
            this.renderJsExpression(resolvedProp),
          );
          const derivedStateGetter = this.addImport(
            `../derivedState/${node.id}.ts`,
            'default',
            node.name,
          );
          return `React.useEffect(() => ${
            stateHook.setStateVar
          }(${derivedStateGetter}(${paramsArg})), [${depsArray.join(', ')}])`;
        }
        case 'api': {
          const node = appDom.getNode(this.dom, stateHook.nodeId, 'queryState');
          const propTypes = argTypesToPropValueTypes(getQueryNodeArgTypes(this.dom, node));
          const resolvedProps = this.resolveBindables(
            `${node.id}.params`,
            node.params ?? {},
            propValueTypesToArgTypes(propTypes),
          );
          const params = this.renderPropsAsObject(resolvedProps);

          const useDataQuery = this.addImport('@mui/toolpad-core', 'useDataQuery', 'useDataQuery');

          const dataUrl = `/api/data/${this.appId}/${this.config.version}/`;

          return `${useDataQuery}(
            ${stateHook.setStateVar}, 
            ${JSON.stringify(dataUrl)}, 
            ${JSON.stringify(node.attributes.api.value)}, 
            ${params}
          );`;
        }
        default:
          throw new Error(
            `Invariant: Missing renderer for state hook of type "${(stateHook as StateHook).type}"`,
          );
      }
    }).join('\n');
  }

  renderPageState(): string {
    const stateHookObjects = new Map<string, ResolvedProps>();
    Array.from(this.controlledStateHooks.values()).forEach((hook) => {
      let hookObject = stateHookObjects.get(hook.nodeName);
      if (!hookObject) {
        hookObject = {};
        stateHookObjects.set(hook.nodeName, hookObject);
      }
      hookObject[hook.propName] = { type: 'expression', value: hook.stateVar };
    });

    const renderedControlledStateProps = Array.from(
      stateHookObjects.entries(),
      ([name, properties]) => `${name}: ${this.renderPropsAsObject(properties)}`,
    );

    const renderedStateProps = Array.from(
      this.stateHooks.values(),
      (hook) => `${hook.nodeName}: ${hook.stateVar}`,
    );

    const renderedUrlQueryState = this.renderPropsAsObject(
      Object.fromEntries(
        Array.from(this.urlQueryStateHooks.values(), (hook) => {
          return [hook.paramName, { type: 'expression', value: hook.stateVar }];
        }),
      ),
    );

    return `{${[
      `page: ${renderedUrlQueryState}`,
      ...renderedControlledStateProps,
      ...renderedStateProps,
    ].join(',')}}`;
  }

  renderMemoizedConsts(): string {
    return this.memoizedConsts
      .map(
        ({ varName, value }) =>
          `const ${varName} = ${this.reactAlias}.useMemo(() => (${value}), [])`,
      )
      .join('\n');
  }

  render() {
    this.collectAllState();

    const urlQueryStateHooks = this.renderUrlQueryStateHooks();
    const controlledStateHooks = this.renderControlledStateHooks();
    const dataQueryState = this.renderDataQueryState();

    this.pageStateIdentifier = this.moduleScope.createUniqueBinding('_pageState');
    this.bindingsStateIdentifier = this.moduleScope.createUniqueBinding('_bindingsState');
    const pageState = this.renderPageState();

    const statehooks = this.renderStateHooks();

    const root: string = this.renderRoot(this.page);

    // TODO: Add seal for memoized consts as well? It needs to run after renderRoot.
    const memoizedConsts = this.renderMemoizedConsts();

    this.imports.seal();

    const imports = this.imports.render();
    const codeComponentImports = this.renderCodeComponentImports();
    return `
      ${imports}
      ${codeComponentImports}

      export default function App () {
        ${urlQueryStateHooks}
        ${controlledStateHooks}
        ${dataQueryState}

        const ${this.pageStateIdentifier} = ${pageState};
        const ${this.bindingsStateIdentifier} = {};
        
        ${statehooks}

        ${memoizedConsts}

        ${
          this.config.editor
            ? `${this.runtimeAlias}.useDiagnostics(${this.pageStateIdentifier}, ${this.bindingsStateIdentifier});`
            : ''
        }

        return (
          ${root}
        );
      }
    `;
  }
}

export default function renderPageCode(
  appId: string,
  dom: appDom.AppDom,
  pageNodeId: NodeId,
  configInit: Partial<RenderPageConfig> = {},
) {
  const config: RenderPageConfig = {
    editor: false,
    pretty: false,
    version: 'preview',
    ...configInit,
  };

  const page = appDom.getNode(dom, pageNodeId, 'page');

  const ctx = new Context(appId, dom, page, config);
  let code: string = ctx.render();

  if (config.pretty) {
    code = tryFormat(code);
  }

  return { code };
}
