/**
 * 云函数：Tesla OAuth 授权（中国区）
 *
 * 功能：
 *   1. passwordLogin: 用邮箱+密码模拟浏览器登录 Tesla，获取 token
 *   2. generateUrl: 生成 OAuth 授权 URL（供 web-view 打开）
 *   3. exchangeCode: 用 authorization_code 换取 token（标准 OAuth）
 *   4. refreshToken: 用 refresh_token 刷新 access_token
 *   5. status: 查询用户的 Tesla 绑定状态
 *   6. unbind: 解绑
 *   7. register: 注册 Partner Account（公钥已托管在云开发静态托管）
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const axios = require('axios')
const crypto = require('crypto')

// Tesla 中国区 Fleet API 配置
const TESLA_CLIENT_ID = '3c92b641-0a9f-40d2-adea-5cad6eb0a70f'
const TESLA_CLIENT_SECRET = 'ta-secret.ql%kwzB!OC_KL-Is'
const TESLA_OAUTH_HOST = 'auth.tesla.cn'
const TESLA_OAUTH_TOKEN_URL = 'https://auth.tesla.cn/oauth2/v3/token'
const TESLA_AUDIENCE = 'https://fleet-api.prd.cn.vn.cloud.tesla.cn'
const TESLA_API_BASE = 'https://fleet-api.prd.cn.vn.cloud.tesla.cn'

// 固定回调地址（passwordLogin 模拟 OAuth 用）
const FAKE_REDIRECT_URI = 'https://auth.tesla.cn/void/callback'

// OAuth 授权回调地址 & 公钥托管域名（云开发静态托管）
const PUBLIC_DOMAIN = 'tesla-oauth-callback-cloudbase-d1gpcr29e89cb8086.webapps.tcloudbase.com'
const OAUTH_REDIRECT_URI = `https://${PUBLIC_DOMAIN}/callback`
const PUBLIC_KEY_HOST = `https://${PUBLIC_DOMAIN}`

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = event.openid || wxContext.OPENID
  const { action } = event

  try {
    switch (action) {

      case 'passwordLogin': {
        const { email, password } = event
        if (!email || !password) return { code: -1, message: '请输入邮箱和密码' }

        const tokenData = await teslaPasswordLogin(email, password)
        if (!tokenData.access_token) {
          return { code: -1, message: tokenData.error || 'Tesla 登录失败，请检查账号密码' }
        }

        const userInfo = await getTeslaUserInfo(tokenData.access_token)

        const saveData = {
          teslaAccessToken: tokenData.access_token,
          teslaRefreshToken: tokenData.refresh_token || '',
          teslaTokenExpiresAt: Date.now() + (tokenData.expires_in || 28800) * 1000,
          teslaUserId: userInfo?.id || '',
          teslaAccountName: userInfo?.email || email,
          teslaBoundAt: db.serverDate()
        }

        await upsertUser(openid, saveData)

        let vehicleCount = 0
        try {
          const vehicleRes = await axios.get(`${TESLA_API_BASE}/api/1/vehicles`, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
            timeout: 10000
          })
          vehicleCount = (vehicleRes.data?.response || []).length
        } catch (e) { /* ignore */ }

        return {
          code: 0, message: 'Tesla 账号绑定成功',
          data: { teslaEmail: userInfo?.email || email, teslaUserId: userInfo?.id || '', vehicleCount, expiresIn: tokenData.expires_in || 28800 }
        }
      }

      case 'generateUrl': {
        const codeVerifier = generateCodeVerifier()
        const codeChallenge = generateCodeChallenge(codeVerifier)
        const state = crypto.randomBytes(16).toString('hex')

        const authUrl = `https://${TESLA_OAUTH_HOST}/oauth2/v3/authorize?` +
          `client_id=${encodeURIComponent(TESLA_CLIENT_ID)}` +
          `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}` +
          `&response_type=code` +
          `&scope=${encodeURIComponent('openid offline_access user_data vehicle_device_data vehicle_cmds vehicle_charging_cmds vehicle_location')}` +
          `&state=${encodeURIComponent(state)}` +
          `&code_challenge=${encodeURIComponent(codeChallenge)}` +
          `&code_challenge_method=S256` +
          `&locale=zh-CN`

        // 确保 oauth_state 集合存在
        try {
          await db.collection('oauth_state').where({ openid }).remove()
        } catch (e) {
          // 集合不存在，尝试创建
          try {
            await db.createCollection('oauth_state')
          } catch (e2) {}
        }
        // 清空旧记录
        try {
          await db.collection('oauth_state').where({ openid }).remove()
        } catch (e) {}
        await db.collection('oauth_state').add({ data: { openid, codeVerifier, state, createdAt: db.serverDate() } })

        return { code: 0, message: 'success', data: { authUrl, state } }
      }

      case 'exchangeCode': {
        const { code } = event
        if (!code) return { code: -1, message: '缺少 code 参数' }

        let codeVerifier = ''
        try {
          const stateRes = await db.collection('oauth_state').where({ openid }).orderBy('createdAt', 'desc').get()
          if (stateRes.data?.length > 0) codeVerifier = stateRes.data[0].codeVerifier || ''
        } catch (e) { /* ignore */ }

        const tokenParams = {
          grant_type: 'authorization_code',
          client_id: TESLA_CLIENT_ID,
          client_secret: TESLA_CLIENT_SECRET,
          code,
          redirect_uri: OAUTH_REDIRECT_URI,
          audience: TESLA_AUDIENCE
        }
        if (codeVerifier) tokenParams.code_verifier = codeVerifier

        const tokenResponse = await axios.post(TESLA_OAUTH_TOKEN_URL, tokenParams, {
          headers: { 'Content-Type': 'application/json' }, timeout: 15000
        })

        const { access_token, refresh_token, expires_in } = tokenResponse.data
        const userInfo = await getTeslaUserInfo(access_token)

        await upsertUser(openid, {
          teslaAccessToken: access_token,
          teslaRefreshToken: refresh_token || '',
          teslaTokenExpiresAt: Date.now() + (expires_in || 28800) * 1000,
          teslaUserId: userInfo?.id || '',
          teslaAccountName: userInfo?.email || ''
        })

        // 获取车辆数量，用于绑定成功后显示
        let vehicleCount = 0
        try {
          const vehicleRes = await axios.get(`${TESLA_API_BASE}/api/1/vehicles`, {
            headers: { Authorization: `Bearer ${access_token}` },
            timeout: 10000
          })
          vehicleCount = (vehicleRes.data?.response || []).length
        } catch (e) { /* ignore */ }

        return { code: 0, message: 'Tesla 账号绑定成功', data: { teslaEmail: userInfo?.email || '', teslaUserId: userInfo?.id || '', vehicleCount, expiresIn: expires_in || 28800 } }
      }

      case 'refreshToken': {
        let refreshToken = event.refreshToken
        if (!refreshToken) {
          const userRes = await db.collection('users').where({ openid }).get()
          if (!userRes.data?.length || !userRes.data[0].teslaRefreshToken) {
            return { code: -2, message: '无 refresh_token，需要重新授权' }
          }
          refreshToken = userRes.data[0].teslaRefreshToken
        }

        const refreshResponse = await axios.post(TESLA_OAUTH_TOKEN_URL, {
          grant_type: 'refresh_token',
          client_id: TESLA_CLIENT_ID,
          refresh_token: refreshToken
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 })

        const { access_token, refresh_token: newRefreshToken, expires_in } = refreshResponse.data

        await db.collection('users').where({ openid }).update({
          data: {
            teslaAccessToken: access_token,
            teslaRefreshToken: newRefreshToken || refreshToken,
            teslaTokenExpiresAt: Date.now() + (expires_in || 28800) * 1000,
            gmt_modified: db.serverDate()
          }
        })

        return { code: 0, message: 'Token 刷新成功', data: { expiresIn: expires_in || 28800 } }
      }

      case 'status': {
        const userRes = await db.collection('users').where({ openid }).get()
        if (!userRes.data?.length) return { code: -1, message: '用户不存在', bound: false }

        const user = userRes.data[0]
        let hasToken = !!user.teslaAccessToken
        let isExpired = user.teslaTokenExpiresAt && user.teslaTokenExpiresAt < Date.now()

        if (hasToken && isExpired && user.teslaRefreshToken) {
          try {
            const refreshRes = await axios.post(TESLA_OAUTH_TOKEN_URL, {
              grant_type: 'refresh_token',
              client_id: TESLA_CLIENT_ID,
              refresh_token: user.teslaRefreshToken
            }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 })
            const { access_token, refresh_token: newRefreshToken, expires_in } = refreshRes.data
            await db.collection('users').where({ openid }).update({
              data: {
                teslaAccessToken: access_token,
                teslaRefreshToken: newRefreshToken || user.teslaRefreshToken,
                teslaTokenExpiresAt: Date.now() + (expires_in || 28800) * 1000,
                gmt_modified: db.serverDate()
              }
            })
            // 更新局部变量
            user.teslaAccessToken = access_token
            isExpired = false
          } catch (e) { /* refresh failed, need re-auth */ }
        }

        // 如果有有效的 token，查询车辆数量
        let vehicleCount = 0
        if (hasToken && !isExpired && user.teslaAccessToken) {
          try {
            const tokenToUse = user.teslaAccessToken
            const vehicleRes = await axios.get(`${TESLA_API_BASE}/api/1/vehicles`, {
              headers: { Authorization: `Bearer ${tokenToUse}` },
              timeout: 10000
            })
            vehicleCount = (vehicleRes.data?.response || []).length
          } catch (e) {
            console.warn('[status] 查询车辆数失败:', e.message)
          }
        }

        return {
          code: 0, bound: hasToken, needRefresh: !!isExpired,
          data: {
            teslaEmail: user.teslaAccountName || '', teslaUserId: user.teslaUserId || '',
            boundAt: user.teslaBoundAt || '', expireAt: user.teslaTokenExpiresAt || 0, isExpired: !!isExpired,
            vehicleCount
          }
        }
      }

      case 'unbind': {
        await db.collection('users').where({ openid }).update({
          data: {
            teslaAccessToken: '', teslaRefreshToken: '', teslaTokenExpiresAt: 0,
            teslaUserId: '', teslaAccountName: '', gmt_modified: db.serverDate()
          }
        })
        return { code: 0, message: '已解除 Tesla 账号绑定' }
      }

      case 'register': {
        console.log('[register] Step 1: 获取 Partner Token...')

        const partnerTokenRes = await axios.post(TESLA_OAUTH_TOKEN_URL,
          new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: TESLA_CLIENT_ID,
            client_secret: TESLA_CLIENT_SECRET,
            audience: TESLA_AUDIENCE,
            scope: 'openid vehicle_device_data vehicle_cmds vehicle_charging_cmds vehicle_location'
          }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
        )

        const partnerToken = partnerTokenRes.data?.access_token
        if (!partnerToken) {
          return { code: -1, message: '获取 Partner Token 失败', responseData: partnerTokenRes.data }
        }

        console.log('[register] Partner Token 获取成功')

        console.log('[register] Step 2: 检查公钥...')
        const publicKeyUrl = `${PUBLIC_KEY_HOST}/.well-known/appspecific/com.tesla.3p.public-key.pem`
        try {
          const keyCheck = await axios.get(publicKeyUrl, { timeout: 10000 })
          console.log('[register] 公钥可访问:', keyCheck.status)
        } catch (e) {
          return { code: -1, message: '公钥不可访问，请确认已部署到静态托管', publicKeyUrl, error: e.message }
        }

        console.log('[register] Step 3: 注册 Partner Account...')
        const registerRes = await axios.post(`${TESLA_API_BASE}/api/1/partner_accounts`,
          { domain: PUBLIC_DOMAIN },
          { headers: { Authorization: `Bearer ${partnerToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        )

        return { code: 0, message: 'Partner Account 注册成功', data: registerRes.data }
      }

      default:
        return { code: -3, message: '未知 action，支持: generateUrl, exchangeCode, passwordLogin, refreshToken, status, unbind, register' }
    }
  } catch (err) {
    console.error('[teslaAuth] 失败:', err)
    return { code: -1, message: '操作失败', error: err.message, statusCode: err.response?.status, responseData: err.response?.data }
  }
}

// ===== 登录模拟 =====

async function teslaPasswordLogin(email, password) {
  try {
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = crypto.randomBytes(16).toString('hex')

    console.log('[teslaLogin] Step 1: 获取登录页...')
    const authPageRes = await axios.get(`https://${TESLA_OAUTH_HOST}/oauth2/v3/authorize`, {
      params: {
        client_id: TESLA_CLIENT_ID, code_challenge, code_challenge_method: 'S256',
        redirect_uri: FAKE_REDIRECT_URI, response_type: 'code',
        scope: 'openid offline_access user_data vehicle_device_data vehicle_cmds vehicle_charging_cmds vehicle_location',
        state, login_hint: email, locale: 'zh-CN'
      },
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      maxRedirects: 0, validateStatus: s => s < 400 || s === 302 || s === 303, timeout: 15000
    })

    let csrfCookie = ''
    const cookies = authPageRes.headers['set-cookie'] || []
    if (cookies.length > 0) csrfCookie = cookies.join('; ')
    const formFields = extractFormFields(authPageRes.data)

    console.log('[teslaLogin] Step 2: 提交登录...')
    const loginRes = await axios.post(`https://${TESLA_OAUTH_HOST}/oauth2/v3/authorize`, null, {
      params: {
        client_id: TESLA_CLIENT_ID, code_challenge, code_challenge_method: 'S256',
        redirect_uri: FAKE_REDIRECT_URI, response_type: 'code',
        scope: 'openid offline_access user_data vehicle_device_data vehicle_cmds vehicle_charging_cmds vehicle_location',
        state, locale: 'zh-CN'
      },
      data: new URLSearchParams({ ...formFields, identity: email, credential: password }).toString(),
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': csrfCookie,
        'Origin': `https://${TESLA_OAUTH_HOST}`,
        'Referer': `https://${TESLA_OAUTH_HOST}/oauth2/v3/authorize`,
        'Accept': 'text/html,application/xhtml+xml'
      },
      maxRedirects: 0, validateStatus: s => s < 400 || s === 302 || s === 303, timeout: 15000
    })

    const location = loginRes.headers['location']
    if (!location) {
      console.error('[teslaLogin] 无重定向:', loginRes.status)
      return { error: '登录失败，请检查账号密码是否正确' }
    }

    const code = new URL(location).searchParams.get('code')
    if (!code) return { error: '获取授权码失败' }

    console.log('[teslaLogin] Step 3: 换 token...')
    const tokenRes = await axios.post(TESLA_OAUTH_TOKEN_URL, {
      grant_type: 'authorization_code', client_id: TESLA_CLIENT_ID, client_secret: TESLA_CLIENT_SECRET,
      code, code_verifier: codeVerifier, redirect_uri: FAKE_REDIRECT_URI, audience: TESLA_AUDIENCE
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 })

    return tokenRes.data
  } catch (err) {
    console.error('[teslaLogin] 错误:', err.message, err.response?.status)
    try {
      console.log('[teslaLogin] 尝试备用登录...')
      return await teslaOwnerApiLogin(email, password)
    } catch (e) {
      return { error: '登录失败: ' + (err.response?.data?.error_description || err.message) }
    }
  }
}

async function teslaOwnerApiLogin(email, password) {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = crypto.randomBytes(16).toString('hex')
  const OAUTH_CLIENT_ID = 'ownerapi'

  const authRes = await axios.get(`https://${TESLA_OAUTH_HOST}/oauth2/v3/authorize`, {
    params: { client_id: OAUTH_CLIENT_ID, code_challenge, code_challenge_method: 'S256', redirect_uri: FAKE_REDIRECT_URI, response_type: 'code', scope: 'openid email offline_access', state },
    headers: { 'User-Agent': 'TeslaApp/4.34.5' },
    maxRedirects: 0, validateStatus: s => s < 400 || s === 302 || s === 303, timeout: 15000
  })

  const formFields = extractFormFields(authRes.data)
  const cookies = (authRes.headers['set-cookie'] || []).join('; ')

  const loginRes = await axios.post(`https://${TESLA_OAUTH_HOST}/oauth2/v3/authorize`, null, {
    params: { client_id: OAUTH_CLIENT_ID, code_challenge, code_challenge_method: 'S256', redirect_uri: FAKE_REDIRECT_URI, response_type: 'code', scope: 'openid email offline_access', state },
    data: new URLSearchParams({ ...formFields, identity: email, credential: password }).toString(),
    headers: { 'User-Agent': 'TeslaApp/4.34.5', 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookies },
    maxRedirects: 0, validateStatus: s => s < 400 || s === 302 || s === 303, timeout: 15000
  })

  const location = loginRes.headers['location']
  if (!location) return { error: '备用登录失败' }

  const code = new URL(location).searchParams.get('code')
  if (!code) return { error: '备用登录获取授权码失败' }

  const tokenRes = await axios.post(TESLA_OAUTH_TOKEN_URL, {
    grant_type: 'authorization_code', client_id: OAUTH_CLIENT_ID, code, code_verifier: codeVerifier, redirect_uri: FAKE_REDIRECT_URI
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 })

  const tokenData = tokenRes.data
  const fleetTokenRes = await axios.post(TESLA_OAUTH_TOKEN_URL, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: TESLA_CLIENT_ID, client_secret: TESLA_CLIENT_SECRET,
    subject_token: tokenData.access_token, subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    audience: TESLA_AUDIENCE
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 })

  return fleetTokenRes.data
}

// ===== 工具函数 =====

async function getTeslaUserInfo(accessToken) {
  try {
    const res = await axios.get(`${TESLA_API_BASE}/api/1/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000
    })
    return res.data?.response || {}
  } catch (err) { return {} }
}

async function upsertUser(openid, data) {
  const userRes = await db.collection('users').where({ openid }).get()
  if (userRes.data.length > 0) {
    await db.collection('users').where({ openid }).update({ data: { ...data, gmt_modified: db.serverDate() } })
  } else {
    await db.collection('users').add({ data: { openid, ...data, gmt_create: db.serverDate(), gmt_modified: db.serverDate() } })
  }
}

function generateCodeVerifier() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  let result = ''
  const bytes = crypto.randomBytes(86)
  for (let i = 0; i < 86; i++) result += chars[bytes[i] % chars.length]
  return result
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest()
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function extractFormFields(html) {
  const fields = {}
  if (!html || typeof html !== 'string') return fields
  const regex = /<input[^>]*type=["']hidden["'][^>]*>/gi
  let match
  while ((match = regex.exec(html)) !== null) {
    const nameMatch = match[0].match(/name=["']([^"']+)["']/i)
    const valueMatch = match[0].match(/value=["']([^"']*)["']/i)
    if (nameMatch) fields[nameMatch[1]] = valueMatch ? valueMatch[1] : ''
  }
  return fields
}
