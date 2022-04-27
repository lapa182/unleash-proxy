import { Request, Response, Router } from 'express';
import { createContext } from './create-context';
import { clientMetricsSchema } from './metrics-schema';
import { IProxyConfig } from './config';
import { IClient } from './client';
import { Logger } from './logger';
import { OpenApiService } from './openapi/openapi-service';
import {
    featuresResponse,
    FeaturesResponseSchema,
} from './openapi/spec/features-response';
import {
    emptySuccessResponse,
    notReadyResponse,
    withCommonResponses,
} from './openapi/common-responses';

export default class UnleashProxy {
    private logger: Logger;

    private clientKeys: string[];

    private serverSideTokens: string[];

    private clientKeysHeaderName: string;

    private client: IClient;

    private ready = false;

    public middleware: Router;

    constructor(
        client: IClient,
        config: IProxyConfig,
        openApiService: OpenApiService,
    ) {
        this.logger = config.logger;
        this.clientKeys = config.clientKeys;
        this.serverSideTokens = config.serverSideSdkConfig
            ? config.serverSideSdkConfig.tokens
            : [];
        this.clientKeysHeaderName = config.clientKeysHeaderName;
        this.client = client;

        if (client.isReady()) {
            this.setReady();
        }

        this.client.on('ready', () => {
            this.setReady();
        });

        const router = Router();
        this.middleware = router;

        // Routes
        router.get(
            '/health',
            openApiService.validPath({
                responses: { 200: emptySuccessResponse, 503: notReadyResponse },
            }),
            this.health.bind(this),
        );
        router.get(
            '/',
            openApiService.validPath({
                responses: withCommonResponses({ 200: featuresResponse }),
            }),
            this.getEnabledToggles.bind(this),
        );
        router.post(
            '/',
            openApiService.validPath({
                responses: withCommonResponses({
                    200: featuresResponse,
                }),
            }),
            this.lookupToggles.bind(this),
        );
        router.post('/client/metrics', this.registerMetrics.bind(this));
        router.get('/client/features', this.unleashApi.bind(this));
    }

    private setReady() {
        this.ready = true;
        this.logger.info(
            'Successfully synchronized with Unleash API. Proxy is now ready to receive traffic.',
        );
    }

    // kept for backward compatibility
    setProxySecrets(clientKeys: string[]): void {
        this.setClientKeys(clientKeys);
    }

    setClientKeys(clientKeys: string[]): void {
        this.clientKeys = clientKeys;
    }

    getEnabledToggles(
        req: Request,
        res: Response<FeaturesResponseSchema>,
    ): void {
        const apiToken = req.header(this.clientKeysHeaderName);

        if (!this.ready) {
            res.status(503).send(NOT_READY_MSG);
        } else if (!apiToken || !this.clientKeys.includes(apiToken)) {
            res.sendStatus(401);
        } else {
            const { query } = req;
            query.remoteAddress = query.remoteAddress || req.ip;
            const context = createContext(query);
            const toggles = this.client.getEnabledToggles(context);
            res.set('Cache-control', 'public, max-age=2');
            res.send({ toggs: toggles });
        }
    }

    lookupToggles(req: Request, res: Response): void {
        const clientToken = req.header(this.clientKeysHeaderName);

        if (!this.ready) {
            res.status(503).send(NOT_READY_MSG);
        } else if (!clientToken || !this.clientKeys.includes(clientToken)) {
            res.sendStatus(401);
        } else {
            const { context, toggles: toggleNames = [] } = req.body;

            const toggles = this.client.getDefinedToggles(toggleNames, context);
            res.send({ toggles });
        }
    }

    health(req: Request, res: Response): void {
        if (!this.ready) {
            res.status(503).send(NOT_READY_MSG);
        } else {
            res.send('ok');
        }
    }

    registerMetrics(req: Request, res: Response): void {
        const token = req.header(this.clientKeysHeaderName);
        const validTokens = [...this.clientKeys, ...this.serverSideTokens];

        if (token && validTokens.includes(token)) {
            const data = req.body;
            const { error, value } = clientMetricsSchema.validate(data);
            if (error) {
                this.logger.warn('Invalid metrics posted', error);
                res.status(400).json(error);
                return;
            }
            this.client.registerMetrics(value);
            res.sendStatus(200);
        } else {
            res.sendStatus(401);
        }
    }

    unleashApi(req: Request, res: Response): void {
        const apiToken = req.header(this.clientKeysHeaderName);
        if (!this.ready) {
            res.status(503).send(NOT_READY_MSG);
        } else if (apiToken && this.serverSideTokens.includes(apiToken)) {
            const features = this.client.getFeatureToggleDefinitions();
            res.set('Cache-control', 'public, max-age=2');
            res.send({ version: 2, features });
        } else {
            res.sendStatus(401);
        }
    }
}

function NOT_READY_MSG(NOT_READY_MSG: any) {
    throw new Error('Function not implemented.');
}
