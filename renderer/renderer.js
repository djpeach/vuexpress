const EventEmitter = require('events');
const Vue = require('vue');
const Vuex = require('vuex');
const serialize = require('serialize-javascript');
const vueServerRenderer = require('vue-server-renderer');
const SSRPlugin = require('../plugins/server');
const StreamTransform = require('./transform');
const ErrorTypes = require('../error');
const Meta = require('vue-meta');

Vue.use(Meta, {
    keyName: 'metaInfo', // the component option name that vue-meta looks for meta info on.
    attribute: 'data-vuexpress-meta', // the attribute name vue-meta adds to the tags it observes
    ssrAttribute: 'data-vuexpress-meta-ssr', // the attribute name that lets vue-meta know that meta info has already been server-rendered
    tagIDKeyName: 'vuexpress' // the property name that vue-meta uses to determine whether to overwrite or append a tag
});

Vue.use(SSRPlugin);
Vue.use(Vuex);

const defaultRendererOptions = {
    head: Object.create(null),
    plugins: [],
    preCompile: [],
    globals: Object.create(null),
};

class Renderer extends EventEmitter {

    /**
     * Creates an instance of Renderer.
     * @param {ICompiler} compiler
     * @param {RendererOptionParams} options
     * @memberof Renderer
     */
    constructor(compiler, options) {
        super();
        this.compiler = compiler;
        this.vueRenderer = vueServerRenderer.createRenderer();
        this.options = Object.assign({}, defaultRendererOptions, options);
        this.init();
    }

    /**
     *
     *
     * @memberof Renderer
     */
    init() {
        const needCompiledPlugin = [];
        this.options.plugins.forEach((plugin) => {
            if (typeof plugin === 'string') {
                needCompiledPlugin.push(plugin);
            }
        });
        this.options.preCompile.push(...needCompiledPlugin);

        this.compiler.load(this.options.preCompile).then(() => {
            this.emit('ready');
        }).catch((e) => {
            const error = new ErrorTypes.BaseError(e);
            this.emit('error', error);
        });
    }

    /**
     *
     *
     * @returns {Promise<Class<Vue>>}
     * @memberof Renderer
     */
    getVueClass() {
        if (this.Vue) return Promise.resolve(this.Vue);

        const needCompiledPlugins = [];
        this.options.plugins.forEach((plugin) => {
            if (typeof plugin === 'string') {
                needCompiledPlugins.push(plugin);
            } else if (plugin.default && plugin.default.install) {
                Vue.use(plugin.default);
            } else {
                Vue.use(plugin);
            }
        });

        if (needCompiledPlugins.length === 0) {
            this.Vue = Vue;
            return Promise.resolve(this.Vue);
        }

        return Promise.all(needCompiledPlugins.map(pluginPath => this.compiler.import(pluginPath)))
            .then((plugins) => {
                plugins.forEach((plugin) => {

                    if (plugin.default && plugin.default.install) {
                        Vue.use(plugin.default);
                    } else {
                        Vue.use(plugin);
                    }
                });
                this.Vue = Vue;
                return this.Vue;
            });
    }

    /**
     * get the component
     *
     * @param {string} path
     * @param {RendererContext} context
     * @returns {Promise<Vue>}
     * @memberof Renderer
     */
    getComponent(path, context) {
        return Promise.all([
            this.getVueClass(),
            this.compiler.import(path).then(object => object.default || object),
        ]).then(([VueClass, VueOptions]) => {
            const SSRVueOptions = Object.assign({}, VueOptions, {$context: context});
            const component = new VueClass(SSRVueOptions);

            if (component.$options.asyncData) {
                return new Promise((resolve) => {
                    component.$options.asyncData().then((data) => {
                        component._data = Object.assign({}, component.$options.data, data);
                        resolve(component)
                    })
                });
            }

            return component;
        });
    }

    /**
     *
     *
     * @param {string} path
     * @param {Object} state
     * @param {RenderOptions} options
     * @returns {Promise<stream$Readable>}
     * @memberof Renderer
     */
    renderToStream(path, state, options) {
        const context = {
            state: state || {},
            url: options ? options.url : '/',
        };
        const isPlain = options && options.plain;

        return this.getComponent(path, context).then((component) => {
            const bodyStream = this.vueRenderer.renderToStream(component);
            bodyStream.on('error', (e) => {
                let error;
                if (e instanceof ErrorTypes.CompilerError) {
                    error = e;
                } else {
                    error = new ErrorTypes.RenderError(e);
                    error.component = path;
                    error.state = state;
                }
                this.emit('error', error);
            });

            if (isPlain) return bodyStream;

            const template = Renderer.getTemplateHtml(component.$meta().inject(), context.state, this.options.globals);
            const transform = new StreamTransform(template.head, template.tail);
            return bodyStream.pipe(transform);
        });
    }

    renderToString(path, state, options) {
        const context = {
            state: state || {},
            url: options ? options.url : '/',
        };
        const isPlain = options && options.plain;
        return this.getComponent(path, context).then(component => new Promise((resolve, reject) => {
            this.vueRenderer.renderToString(component, (e, result) => {
                if (e) {
                    e.component = path;
                    reject(e);
                    return;
                }
                if (isPlain) {
                    resolve(result);
                    return;
                }

                const indexHtml = Renderer.getTemplateHtml(component.$meta().inject(), context.state, this.options.globals);
                const html = `${indexHtml.head}${result}${indexHtml.tail}`;
                resolve(html);
            });
        }));
    }

    /**
     *
     *
     * @static
     * @param {Object}
     * @param {Object} state
     * @returns {{ head: string, tail: string }}
     * @memberof Renderer
     */
    static getTemplateHtml({title, htmlAttrs, bodyAttrs, link, style, script, noscript, meta}, state, globalVars) {

        const bodyOpt = { body: true };

        const head = `<!DOCTYPE html>
<html ${htmlAttrs.text()}>
<head>
${meta.text()}
${title.text()}
${link.text()}
${style.text()}
${script.text()}
${noscript.text()}
</head>
<body ${bodyAttrs.text()}>
  `;

        const tail = `
${script.text(bodyOpt)}</body>
</html>`;

        return {head, tail};
    }
}

module.exports = Renderer;
