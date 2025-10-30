// server.js - Backend con NewsAPI para datos reales
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3001;

// ⚙️ CONFIGURACIÓN DE NEWSAPI
const NEWSAPI_KEY = '6c069331086f4735bfce4f4edf639bca'; // Tu API Key de NewsAPI
const NEWSAPI_URL = 'https://newsapi.org/v2/everything';

// Cache: guarda resultados por 1 hora
const cache = new NodeCache({ stdTTL: 3600 });

// Permitir peticiones desde el frontend
app.use(cors());
app.use(express.json());

// Candidatos oficiales
const CANDIDATES = [
    'Evelyn Matthei',
    'José Antonio Kast',
    'Johannes Kaiser',
    'Franco Parisi',
    'Marco Enríquez-Ominami',
    'Harold Mayne-Nicholls',
    'Jeannette Jara',
    'Eduardo Artés'
];

// Dominios de medios chilenos (para NewsAPI)
const CHILE_DOMAINS = [
    'latercera.com',
    'emol.com',
    'biobiochile.cl',
    'cooperativa.cl',
    't13.cl',
    'tvn.cl',
    'meganoticias.cl',
    'chvnoticias.cl',
    'df.cl',
    'elmostrador.cl'
].join(',');

// Función para buscar menciones con NewsAPI
async function searchWithNewsAPI(candidateName, dateFrom = null, dateTo = null) {
    try {
        const now = new Date();
        const defaultFrom = new Date(now.setDate(now.getDate() - 30)); // Últimos 30 días por defecto

        const params = {
            apiKey: NEWSAPI_KEY,
            q: candidateName,
            domains: CHILE_DOMAINS,
            language: 'es',
            sortBy: 'publishedAt',
            pageSize: 100, // Máximo permitido
            from: dateFrom || defaultFrom.toISOString(),
            to: dateTo || new Date().toISOString()
        };

        console.log(`🔍 Buscando en NewsAPI: ${candidateName}`);

        const response = await axios.get(NEWSAPI_URL, { params });
        const data = response.data;

        if (data.status !== 'ok') {
            throw new Error(data.message || 'Error en NewsAPI');
        }

        const articles = data.articles || [];
        const totalResults = data.totalResults || 0;

        // Organizar artículos por medio
        const articlesBySource = {};
        articles.forEach(article => {
            const sourceName = article.source.name;
            if (!articlesBySource[sourceName]) {
                articlesBySource[sourceName] = [];
            }
            articlesBySource[sourceName].push({
                title: article.title,
                description: article.description,
                url: article.url,
                publishedAt: article.publishedAt,
                author: article.author,
                urlToImage: article.urlToImage
            });
        });

        console.log(`✅ NewsAPI: ${totalResults} resultados encontrados`);
        console.log(`   📰 Artículos obtenidos: ${articles.length}`);
        console.log(`   🗞️  Medios: ${Object.keys(articlesBySource).join(', ')}`);

        return {
            totalResults: totalResults,
            articlesCount: articles.length,
            articlesBySource: articlesBySource,
            allArticles: articles
        };

    } catch (error) {
        if (error.response && error.response.status === 426) {
            console.error('❌ Error: API Key requiere plan de pago para dominios específicos');
            console.log('💡 Intentando búsqueda general en Chile...');

            // Fallback: búsqueda general sin restricción de dominio
            return await searchWithNewsAPIGeneral(candidateName, dateFrom, dateTo);
        }

        console.error(`❌ Error en NewsAPI:`, error.message);
        return {
            totalResults: 0,
            articlesCount: 0,
            articlesBySource: {},
            allArticles: []
        };
    }
}

// Fallback: búsqueda general sin restricción de dominio
async function searchWithNewsAPIGeneral(candidateName, dateFrom = null, dateTo = null) {
    try {
        const now = new Date();
        const defaultFrom = new Date(now.setDate(now.getDate() - 30));

        const params = {
            apiKey: NEWSAPI_KEY,
            q: `${candidateName} Chile`,
            language: 'es',
            sortBy: 'publishedAt',
            pageSize: 100,
            from: dateFrom || defaultFrom.toISOString(),
            to: dateTo || new Date().toISOString()
        };

        const response = await axios.get(NEWSAPI_URL, { params });
        const data = response.data;

        if (data.status !== 'ok') {
            throw new Error(data.message || 'Error en NewsAPI');
        }

        const articles = data.articles || [];
        const totalResults = data.totalResults || 0;

        const articlesBySource = {};
        articles.forEach(article => {
            const sourceName = article.source.name;
            if (!articlesBySource[sourceName]) {
                articlesBySource[sourceName] = [];
            }
            articlesBySource[sourceName].push({
                title: article.title,
                description: article.description,
                url: article.url,
                publishedAt: article.publishedAt,
                author: article.author,
                urlToImage: article.urlToImage
            });
        });

        console.log(`✅ NewsAPI (general): ${totalResults} resultados`);

        return {
            totalResults: totalResults,
            articlesCount: articles.length,
            articlesBySource: articlesBySource,
            allArticles: articles
        };

    } catch (error) {
        console.error(`❌ Error en búsqueda general:`, error.message);
        return {
            totalResults: 0,
            articlesCount: 0,
            articlesBySource: {},
            allArticles: []
        };
    }
}

// Procesar resultados por categoría de medio con PONDERACIÓN INTELIGENTE
function categorizeResults(articlesBySource, candidateName) {
    const results = {
        prensa: [],
        tv: [],
        radio: [],
        otros: [],
        total: 0,
        weightedScore: 0,
        metrics: {
            titleMentions: 0,
            descriptionMentions: 0,
            recentArticles: 0, // últimos 7 días
            oldArticles: 0,
            sentiment: { positive: 0, neutral: 0, negative: 0 },
            frequency: 0
        }
    };

    const mediaCategories = {
        prensa: ['La Tercera', 'El Mercurio', 'Emol', 'BioBioChile', 'Cooperativa', 'El Mostrador', 'DF'],
        tv: ['T13', 'TVN', 'Mega', 'CHV', 'CNN Chile'],
        radio: ['BioBioChile', 'Cooperativa', 'ADN Radio']
    };

    // Pesos de calidad por fuente
    const sourceWeights = {
        'La Tercera': 1.2,
        'El Mercurio': 1.2,
        'Emol': 1.2,
        'T13': 1.1,
        'TVN': 1.1,
        'CNN Chile': 1.1,
        'El Mostrador': 1.0,
        'BioBioChile': 1.0,
        'Cooperativa': 1.0,
        'default': 0.8
    };

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    let totalWeightedScore = 0;

    for (const [sourceName, articles] of Object.entries(articlesBySource)) {
        let category = 'otros';

        // Determinar categoría
        for (const [cat, sources] of Object.entries(mediaCategories)) {
            if (sources.some(s => sourceName.toLowerCase().includes(s.toLowerCase()))) {
                category = cat;
                break;
            }
        }

        const sourceWeight = sourceWeights[sourceName] || sourceWeights['default'];
        let sourceScore = 0;

        // Analizar cada artículo
        articles.forEach(article => {
            let articleScore = 1; // Base score

            // 1. PROMINENCIA EN TÍTULO (peso: 2x)
            const titleLower = (article.title || '').toLowerCase();
            const candidateLower = candidateName.toLowerCase();
            const candidateLastName = candidateName.split(' ').pop().toLowerCase();

            if (titleLower.includes(candidateLower) || titleLower.includes(candidateLastName)) {
                articleScore *= 2;
                results.metrics.titleMentions++;
            }

            // 2. MENCIÓN EN DESCRIPCIÓN (peso: 1.3x)
            const descLower = (article.description || '').toLowerCase();
            if (descLower.includes(candidateLower) || descLower.includes(candidateLastName)) {
                articleScore *= 1.3;
                results.metrics.descriptionMentions++;
            }

            // 3. RECENCIA (peso: 1.5x para últimos 7 días, 1.2x para últimos 14 días)
            const publishDate = new Date(article.publishedAt);
            const daysDiff = (now - publishDate) / (1000 * 60 * 60 * 24);

            if (daysDiff <= 7) {
                articleScore *= 1.5;
                results.metrics.recentArticles++;
            } else if (daysDiff <= 14) {
                articleScore *= 1.2;
            } else {
                results.metrics.oldArticles++;
            }

            // 4. ANÁLISIS DE SENTIMIENTO BÁSICO (palabras clave)
            const positiveWords = ['lidera', 'gana', 'favorito', 'sube', 'avanza', 'crece', 'éxito', 'victoria'];
            const negativeWords = ['cae', 'baja', 'pierde', 'rechaza', 'crítica', 'polémica', 'crisis'];

            const textToAnalyze = `${titleLower} ${descLower}`.toLowerCase();

            let sentiment = 'neutral';
            let sentimentMultiplier = 1;

            const positiveCount = positiveWords.filter(w => textToAnalyze.includes(w)).length;
            const negativeCount = negativeWords.filter(w => textToAnalyze.includes(w)).length;

            if (positiveCount > negativeCount) {
                sentiment = 'positive';
                sentimentMultiplier = 1.2;
                results.metrics.sentiment.positive++;
            } else if (negativeCount > positiveCount) {
                sentiment = 'negative';
                sentimentMultiplier = 0.9;
                results.metrics.sentiment.negative++;
            } else {
                results.metrics.sentiment.neutral++;
            }

            articleScore *= sentimentMultiplier;

            // 5. PESO DE LA FUENTE
            articleScore *= sourceWeight;

            sourceScore += articleScore;
        });

        const recentArticle = articles[0]; // El más reciente

        results[category].push({
            name: sourceName,
            count: articles.length,
            score: Math.round(sourceScore),
            recentArticle: recentArticle ? {
                title: recentArticle.title,
                link: recentArticle.url,
                date: recentArticle.publishedAt,
                description: recentArticle.description,
                image: recentArticle.urlToImage
            } : null,
            allArticles: articles.slice(0, 5)
        });

        results.total += articles.length;
        totalWeightedScore += sourceScore;
    }

    // Calcular frecuencia (artículos por día)
    results.metrics.frequency = (results.total / 30).toFixed(2); // Promedio diario en últimos 30 días

    results.weightedScore = Math.round(totalWeightedScore);

    return results;
}

// ENDPOINTS DE LA API

app.get('/api/candidate/:name', async (req, res) => {
    try {
        const candidateName = decodeURIComponent(req.params.name);
        const dateFrom = req.query.from || null;
        const dateTo = req.query.to || null;

        const cacheKey = `${candidateName}_${dateFrom}_${dateTo}`;
        const cached = cache.get(cacheKey);

        if (cached) {
            console.log(`📦 Cache hit para: ${candidateName}`);
            return res.json({
                success: true,
                data: cached,
                cached: true,
                timestamp: new Date().toISOString()
            });
        }

        console.log(`🔍 Buscando datos frescos para: ${candidateName}`);

        const newsData = await searchWithNewsAPI(candidateName, dateFrom, dateTo);
        const categorizedData = categorizeResults(newsData.articlesBySource, candidateName);

        const result = {
            ...categorizedData,
            totalResults: newsData.totalResults,
            articlesCount: newsData.articlesCount
        };

        cache.set(cacheKey, result);

        res.json({
            success: true,
            data: result,
            cached: false,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/ranking', async (req, res) => {
    try {
        const dateFrom = req.query.from || null;
        const dateTo = req.query.to || null;

        const cacheKey = `full_ranking_${dateFrom}_${dateTo}`;
        const cached = cache.get(cacheKey);

        if (cached) {
            console.log('📦 Retornando ranking desde cache');
            return res.json({
                success: true,
                data: cached,
                cached: true,
                timestamp: new Date().toISOString()
            });
        }

        console.log('🚀 Generando ranking completo con NewsAPI...');
        const ranking = [];
        const startTime = Date.now();

        for (let i = 0; i < CANDIDATES.length; i++) {
            const candidate = CANDIDATES[i];
            console.log(`\n[${i + 1}/${CANDIDATES.length}] Procesando: ${candidate}`);

            const newsData = await searchWithNewsAPI(candidate, dateFrom, dateTo);
            const categorizedData = categorizeResults(newsData.articlesBySource, candidate);

            ranking.push({
                name: candidate,
                mentions: categorizedData.total,
                weightedScore: categorizedData.weightedScore,
                metrics: categorizedData.metrics,
                totalResults: newsData.totalResults,
                articlesCount: newsData.articlesCount,
                media: {
                    prensa: categorizedData.prensa.map(m => m.name),
                    tv: categorizedData.tv.map(m => m.name),
                    radio: categorizedData.radio.map(m => m.name),
                    otros: categorizedData.otros.map(m => m.name)
                },
                details: categorizedData
            });

            // Pausa para no exceder rate limit (NewsAPI: 100 requests/día en plan gratuito)
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Ordenar por SCORE PONDERADO, no por menciones simples
        ranking.sort((a, b) => b.weightedScore - a.weightedScore);
        cache.set(cacheKey, ranking);

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ Ranking completado en ${duration} segundos`);

        res.json({
            success: true,
            data: ranking,
            cached: false,
            timestamp: new Date().toISOString(),
            duration: `${duration}s`
        });

    } catch (error) {
        console.error('Error generando ranking:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/api/cache/clear', (req, res) => {
    const keysCleared = cache.keys().length;
    cache.flushAll();
    console.log(`🗑️  Cache limpiado: ${keysCleared} entradas eliminadas`);
    res.json({
        success: true,
        message: `Cache limpiado: ${keysCleared} entradas`,
        keys_cleared: keysCleared
    });
});

app.get('/health', (req, res) => {
    const cacheKeys = cache.keys();
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        api: 'NewsAPI',
        apiConfigured: NEWSAPI_KEY !== 'TU_API_KEY_AQUI',
        cache: {
            entries: cacheKeys.length,
            keys: cacheKeys
        },
        uptime: process.uptime()
    });
});

app.get('/', (req, res) => {
    res.json({
        name: 'Ranking Presidencial Chile 2025 - API con NewsAPI',
        version: '3.0.0',
        dataSource: 'NewsAPI.org',
        endpoints: {
            ranking: 'GET /api/ranking?from=YYYY-MM-DD&to=YYYY-MM-DD',
            candidate: 'GET /api/candidate/:name?from=YYYY-MM-DD&to=YYYY-MM-DD',
            cache_clear: 'POST /api/cache/clear',
            health: 'GET /health'
        },
        notes: [
            'Los parámetros from y to son opcionales',
            'Por defecto busca en los últimos 30 días',
            'NewsAPI plan gratuito: 100 requests/día',
            'Formato de fecha: YYYY-MM-DD (ej: 2025-01-15)'
        ]
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 SERVIDOR DE RANKING PRESIDENCIAL INICIADO');
    console.log('='.repeat(60));
    console.log(`\n📡 URL del servidor: http://localhost:${PORT}`);
    console.log(`\n📰 Fuente de datos: NewsAPI.org`);
    console.log(`   API Key configurada: ${NEWSAPI_KEY !== 'TU_API_KEY_AQUI' ? '✅ Sí' : '❌ No - Reemplazar en el código'}`);
    console.log(`\n📊 Endpoints disponibles:`);
    console.log(`   GET  http://localhost:${PORT}/api/ranking`);
    console.log(`   GET  http://localhost:${PORT}/api/candidate/:name`);
    console.log(`   POST http://localhost:${PORT}/api/cache/clear`);
    console.log(`   GET  http://localhost:${PORT}/health`);
    console.log(`\n💡 Candidatos monitoreados: ${CANDIDATES.length}`);
    console.log(`📰 Dominios configurados: ${CHILE_DOMAINS.split(',').length}`);
    console.log(`\n⏱️  Cache configurado: 1 hora`);
    console.log(`\n🔑 Para usar NewsAPI:`);
    console.log(`   1. Reemplaza NEWSAPI_KEY con tu API Key`);
    console.log(`   2. Reinicia el servidor`);
    console.log(`   3. Plan gratuito: 100 requests/día`);
    console.log(`\n✨ Presiona Ctrl+C para detener el servidor\n`);
    console.log('='.repeat(60) + '\n');
});

module.exports = app;