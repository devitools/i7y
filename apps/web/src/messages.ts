import connectionsEn from './locales/en/connections'
import connectionsPtBR from './locales/pt-BR/connections'
import connectionsUk from './locales/uk/connections'
import mcpEn from './locales/en/mcp'
import mcpPtBR from './locales/pt-BR/mcp'
import mcpUk from './locales/uk/mcp'
import en from './locales/en/messages'
import ptBR from './locales/pt-BR/messages'
import uk from './locales/uk/messages'
import alertsEn from './locales/en/alerts'
import alertsPtBR from './locales/pt-BR/alerts'
import alertsUk from './locales/uk/alerts'

import operationsEn from './locales/en/operations'
import operationsPtBR from './locales/pt-BR/operations'
import operationsUk from './locales/uk/operations'

export const messages = { en:{...connectionsEn,...en,...alertsEn,...operationsEn,...mcpEn}, 'pt-BR':{...connectionsPtBR,...ptBR,...alertsPtBR,...operationsPtBR,...mcpPtBR}, uk:{...connectionsUk,...uk,...alertsUk,...operationsUk,...mcpUk} }
