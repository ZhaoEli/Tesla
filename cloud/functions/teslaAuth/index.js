/**
 * 云函数：Tesla OAuth 授权
 *
 * 功能：
 *   1. passwordLogin: 用邮箱+密码模拟浏览器登录 Tesla，获取 token（无需 redirect_uri）
 *   2. exchangeCode: 用 authorization_code 换取 token（标准 OAuth）
 *   3. refreshToken: 用 refresh_token 刷新 access_token
 *   4. status: 查询用户的 Tesla 绑定状态
 *   5. unbind: 解绑
 *
 * 调用方式：
 *   wx.cloud.callFunction({ name: 'teslaAuth', data: { action: 'passwordLogin', email, password } })
 *   wx.cloud.callFunction({ name: 'teslaAuth', data: { action: 'status' } })
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const axios = require('axios')
const crypto = require('crypto')

// Tesla OAuth 配置（内联硬编码，无需外部 config.js 文件）
const TESLA_CLIENT_ID = '3c92b641-0a9f-40d2-adea-5cad6eb0a70f'
const TESLA_CLIENT_SECRET = 'ta-secret.ql%kwzB!OC_KL-Is'
const TESLA_AUDIENCE = 'https://fleet-api.prd.na.tesla.com'
const TESLA_OAUTH_TOKEN_URL = 'https://auth.tesla.cn/oauth2/v3/token'
const TESLA_API_BASE = 'https://fleet-api.prd.na.tesla.com'

// 用于 passwordLogin 的固定回调地址（不会被实际访问，只是为了满足 OAuth 参数要求）
const FAKE_REDIRECT_URI = 'https://auth.tesla.cn/void/callback'

// OAuth 授权回调地址 - 已部署在云开发静态托管
const OAUTH_REDIRECT_URI = 'https://tesla-oauth-callback-cloudbase-d1gpcr29e89cb8086.webapps.tcloudbase.com/callback'

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = event.openid || wxContext.OPENID

  const { action } = event

  try {
    switch (action) {

      // =============================================
      // 1. 用邮箱+密码登录（模拟浏览器 OAuth 流程）
      // =============================================
      case 'passwordLogin': {
        const { email, password } = event
        if (!email || !password) {
          return { code: -1, message: '请输入邮箱和密码' }
        }

        // 调用模拟登录获取 token
        const tokenData = await teslaPasswordLogin(email, password)

        if (!tokenData.access_token) {
          return { code: -1, message: tokenData.error || 'Tesla 登录失败，请检查账号密码' }
        }

        // 获取 Tesla 用户信息
        const userInfo = await getTeslaUserInfo(tokenData.access_token)

        // 存入数据库
        const saveData = {
          teslaAccessToken: tokenData.access_token,
          teslaRefreshToken: tokenData.refresh_token || '',
          teslaTokenExpiresAt: Date.now() + (tokenData.expires_in || 28800) * 1000,
          teslaUserId: userInfo?.id || '',
          teslaAccountName: userInfo?.email || email,
          teslaBoundAt: db.serverDate()
        }

        const userRes = await db.collection('users').where({ openid }).get()
        if (userRes.data.length > 0) {
          await db.collection('users').where({ openid }).update({
            data: { ...saveData, gmt_modified: db.serverDate() }
          })
        } else {
          await db.collection('users').add({
            data: {
              openid,
              ...saveData,
              gmt_create: db.serverDate(),
              gmt_modified: db.serverDate()
            }
          })
        }

        // 获取车辆列表
        let vehicleCount = 0
        try {
          const vehicleRes = await axios.get(`${TESLA_API_BASE}/api/1/vehicles`, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
            timeout: 10000
          })
          const vehicles = vehicleRes.data?.response || []
          vehicleCount = vehicles.length
        } catch (e) {
          // 车辆列表获取失败不影响绑定
        }

        return {
          code: 0,
          message: 'Tesla 账号绑定成功',
          data: {
            teslaEmail: userInfo?.email || email,
            teslaUserId: userInfo?.id || '',
            vehicleCount,
            expiresIn: tokenData.expires_in || 28800
          }
        }
      }

      // =============================================
      // 2. 生成 OAuth 授权 URL（供 web-view 打开 Tesla 登录页）
      // =============================================
      case 'generateUrl': {
        const codeVerifier = generateCodeVerifier()
        const codeChallenge = generateCodeChallenge(codeVerifier)
        const state = crypto.randomBytes(16).toString('hex')

        const authUrl = `https://auth.tesla.cn/oauth2/v3/authorize?` +
          `client_id=${encodeURIComponent(TESLA_CLIENT_ID)}` +
          `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}` +
          `&response_type=code` +
          `&scope=${encodeURIComponent('openid offline_access user_data vehicle_device_data vehicle_cmds vehicle_charging_cmds')}` +
          `&state=${encodeURIComponent(state)}` +
          `&code_challenge=${encodeURIComponent(codeChallenge)}` +
          `&code_challenge_method=S256` +
          `&locale=zh-CN`

        // 在数据库中暂存 code_verifier 和 state（后续 exchangeCode 时需要用 code_verifier）
        const wxContext = cloud.getWXContext()
        const openid = event.openid || wxContext.OPENID
        await db.collection('oauth_state').where({ openid }).remove()
        await db.collection('oauth_state').add({
          data: {
            openid,
            codeVerifier,
            state,
            createdAt: db.serverDate()
          }
        })

        return {
          code: 0,
          message: 'success',
          data: { authUrl, state }
        }
      }

      // =============================================
      // 3. 用 authorization_code 换 token（标准 OAuth）
      // =============================================
      case 'exchangeCode': {
        const { code, state: callbackState } = event
        if (!code) {
          return { code: -1, message: '缺少 code 参数' }
        }

        // 从数据库获取之前保存的 code_verifier
        const wxContext = cloud.getWXContext()
        const openid = event.openid || wxContext.OPENID
        let codeVerifier = ''

        try {
          const stateRes = await db.collection('oauth_state').where({ openid }).orderBy('createdAt', 'desc').get()
          if (stateRes.data && stateRes.data.length > 0) {
            codeVerifier = stateRes.data[0].codeVerifier || ''
          }
        } catch (e) {
          // 没查到也没关系，有的 flow 不用 code_verifier
        }

        // 构建请求参数
        const tokenParams = {
          grant_type: 'authorization_code',
          client_id: TESLA_CLIENT_ID,
          client_secret: TESLA_CLIENT_SECRET,
          code,
          redirect_uri: OAUTH_REDIRECT_URI,
          audience: TESLA_AUDIENCE
        }
        if (codeVerifier) {
          tokenParams.code_verifier = codeVerifier
        }

        const tokenResponse = await axios.post(TESLA_OAUTH_TOKEN_URL, tokenParams, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000
        })

        const { access_token, refresh_token, expires_in } = tokenResponse.data
        const userInfo = await getTeslaUserInfo(access_token)

        await saveUserTokens(openid, {
          teslaAccessToken: access_token,
          teslaRefreshToken: refresh_token || '',
          teslaTokenExpiresAt: Date.now() + (expires_in || 28800) * 1000,
          teslaUserId: userInfo?.id || '',
          teslaAccountName: userInfo?.email || ''
        })

        return {
          code: 0,
          message: 'Tesla 账号绑定成功',
          data: {
            teslaEmail: userInfo?.email || '',
            teslaUserId: userInfo?.id || '',
            expiresIn: expires_in || 28800
          }
        }
      }

      // =============================================
      // 3. 刷新 access_token
      // =============================================
      case 'refreshToken': {
        let refreshToken = event.refreshToken

        if (!refreshToken) {
          const userRes = await db.collection('users').where({ openid }).get()
          if (!userRes.data || userRes.data.length === 0 || !userRes.data[0].teslaRefreshToken) {
            return { code: -2, message: '无 refresh_token，需要重新授权' }
          }
          refreshToken = userRes.data[0].teslaRefreshToken
        }

        const refreshResponse = await axios.post(TESLA_OAUTH_TOKEN_URL, {
          grant_type: 'refresh_token',
          client_id: TESLA_CLIENT_ID,
          refresh_token: refreshToken
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000
        })

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

      // =============================================
      // 4. 查询绑定状态
      // =============================================
      case 'status': {
        const userRes = await db.collection('users').where({ openid }).get()
        if (!userRes.data || userRes.data.length === 0) {
          return { code: -1, message: '用户不存在', bound: false }
        }

        const user = userRes.data[0]
        const hasToken = !!user.teslaAccessToken
        const isExpired = user.teslaTokenExpiresAt && user.teslaTokenExpiresAt < Date.now()

        if (hasToken && isExpired && user.teslaRefreshToken) {
          try {
            const refreshRes = await axios.post(TESLA_OAUTH_TOKEN_URL, {
              grant_type: 'refresh_token',
              client_id: TESLA_CLIENT_ID,
              refresh_token: user.teslaRefreshToken
            }, {
              headers: { 'Content-Type': 'application/json' },
              timeout: 15000
            })
            const { access_token, refresh_token: newRefreshToken, expires_in } = refreshRes.data
            await db.collection('users').where({ openid }).update({
              data: {
                teslaAccessToken: access_token,
                teslaRefreshToken: newRefreshToken || user.teslaRefreshToken,
                teslaTokenExpiresAt: Date.now() + (expires_in || 28800) * 1000,
                gmt_modified: db.serverDate()
              }
            })
          } catch (e) {
            // 刷新失败，需要重新授权
          }
        }

        return {
          code: 0,
          bound: hasToken,
          needRefresh: !!isExpired,
          data: {
            teslaEmail: user.teslaAccountName || '',
            teslaUserId: user.teslaUserId || '',
            boundAt: user.teslaBoundAt || '',
            expireAt: user.teslaTokenExpiresAt || 0,
            isExpired: !!isExpired
          }
        }
      }

      // =============================================
      // 5. 解绑
      // =============================================
      case 'unbind': {
        await db.collection('users').where({ openid }).update({
          data: {
            teslaAccessToken: '',
            teslaRefreshToken: '',
            teslaTokenExpiresAt: 0,
            teslaUserId: '',
            teslaAccountName: '',
            gmt_modified: db.serverDate()
          }
        })
        return { code: 0, message: '已解除 Tesla 账号绑定' }
      }

      default:
        return { code: -3, message: '未知 action，支持: generateUrl, exchangeCode, passwordLogin, refreshToken, status, unbind' }
    }
  } catch (err) {
    console.error('[teslaAuth] 失败:', err)
    return {
      code: -1,
      message: '操作失败',
      error: err.message,
      statusCode: err.response?.status,
      responseData: err.response?.data
    }
  }
}

/**
 * 用邮箱+密码模拟 Tesla OAuth 登录
 *
 * 流程（模拟标准浏览器 OAuth 授权码流程）：
 *   1. 生成 code_verifier 和 code_challenge（PKCE）
 *   2. GET /authorize 获取登录页的 CSRF token
 *   3. POST /authorize 提交邮箱密码，获取 authorization_code
 *   4. POST /token 用 code 换取 access_token + refresh_token
 */
async function teslaPasswordLogin(email, password) {
  try {
    // 生成 PKCE 参数
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = crypto.randomBytes(16).toString('hex')

    // Step 1: GET /authorize 获取登录页
    console.log('[teslaLogin] Step 1: 获取登录页...')
    const authPageRes = await axios.get('https://auth.tesla.cn/oauth2/v3/authorize', {
      params: {
        client_id: TESLA_CLIENT_ID,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: FAKE_REDIRECT_URI,
        response_type: 'code',
        scope: 'openid offline_access user_data vehicle_device_data vehicle_cmds vehicle_charging_cmds',
        state,
        login_hint: email,
        locale: 'zh-CN'
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      maxRedirects: 0,
      validateStatus: status => status < 400 || status === 303 || status === 302,
      timeout: 15000
    })

    // 如果返回 303 重定向到 auth.tesla.cn，说明是已经重定向到中国区了
    let csrfCookie = ''
    const cookies = authPageRes.headers['set-cookie'] || []
    if (cookies.length > 0) {
      csrfCookie = cookies.join('; ')
    }

    // 解析登录页表单，提取 CSRF 相关字段
    const html = authPageRes.data
    const formFields = extractFormFields(html)

    console.log('[teslaLogin] Step 2: 提交登录表单...')

    // Step 2: POST /authorize 提交邮箱密码
    const loginRes = await axios.post('https://auth.tesla.cn/oauth2/v3/authorize', null, {
      params: {
        client_id: TESLA_CLIENT_ID,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: FAKE_REDIRECT_URI,
        response_type: 'code',
        scope: 'openid offline_access user_data vehicle_device_data vehicle_cmds vehicle_charging_cmds',
        state,
        locale: 'zh-CN'
      },
      data: new URLSearchParams({
        ...formFields,
        identity: email,
        credential: password
      }).toString(),
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': csrfCookie,
        'Origin': 'https://auth.tesla.cn',
        'Referer': 'https://auth.tesla.cn/oauth2/v3/authorize',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      maxRedirects: 0,
      validateStatus: status => status < 400 || status === 302 || status === 303,
      timeout: 15000
    })

    // 从 Location header 提取 authorization_code
    const location = loginRes.headers['location']
    if (!location) {
      console.error('[teslaLogin] 登录失败，无重定向:', loginRes.status, loginRes.data?.substring(0, 500))
      return { error: '登录失败，请检查账号密码是否正确' }
    }

    console.log('[teslaLogin] 重定向URL:', location)

    // 解析 URL 中的 code 参数
    const urlObj = new URL(location)
    const code = urlObj.searchParams.get('code')

    if (!code) {
      return { error: '获取授权码失败：' + location }
    }

    console.log('[teslaLogin] Step 3: 用 code 换 token...')

    // Step 3: POST /token 换 token
    const tokenRes = await axios.post(TESLA_OAUTH_TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: TESLA_CLIENT_ID,
      client_secret: TESLA_CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
      redirect_uri: FAKE_REDIRECT_URI,
      audience: TESLA_AUDIENCE
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    })

    console.log('[teslaLogin] Token 获取成功')

    return tokenRes.data
  } catch (err) {
    console.error('[teslaLogin] 详细错误:', err.message, err.response?.status, err.response?.data)

    // 如果模拟登录失败，尝试直接使用 ownerapi 方式登录（老 API）
    try {
      console.log('[teslaLogin] 尝试备用登录方式...')
      return await teslaOwnerApiLogin(email, password)
    } catch (fallbackErr) {
      console.error('[teslaLogin] 备用登录也失败:', fallbackErr.message)
      return { error: '登录失败: ' + (err.response?.data?.error_description || err.message) }
    }
  }
}

/**
 * 备用方式：用 Tesla Owner API 方式登录
 * 这种方式适用于较旧的 Tesla API
 */
async function teslaOwnerApiLogin(email, password) {
  const OAUTH_CLIENT_ID = 'ownerapi'
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = crypto.randomBytes(16).toString('hex')

  // Step 1: GET authorize
  const authRes = await axios.get('https://auth.tesla.cn/oauth2/v3/authorize', {
    params: {
      client_id: OAUTH_CLIENT_ID,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      redirect_uri: FAKE_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email offline_access',
      state
    },
    headers: {
      'User-Agent': 'TeslaApp/4.34.5',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    maxRedirects: 0,
    validateStatus: status => status < 400 || status === 302 || status === 303,
    timeout: 15000
  })

  const html = authRes.data
  const formFields = extractFormFields(html)
  const cookies = (authRes.headers['set-cookie'] || []).join('; ')

  // Step 2: POST authorize
  const loginRes = await axios.post('https://auth.tesla.cn/oauth2/v3/authorize', null, {
    params: {
      client_id: OAUTH_CLIENT_ID,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      redirect_uri: FAKE_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email offline_access',
      state
    },
    data: new URLSearchParams({
      ...formFields,
      identity: email,
      credential: password
    }).toString(),
    headers: {
      'User-Agent': 'TeslaApp/4.34.5',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookies
    },
    maxRedirects: 0,
    validateStatus: status => status < 400 || status === 302 || status === 303,
    timeout: 15000
  })

  const location = loginRes.headers['location']
  if (!location) {
    return { error: '备用登录也失败，请检查账号密码' }
  }

  const code = new URL(location).searchParams.get('code')
  if (!code) {
    return { error: '备用登录获取授权码失败' }
  }

  // Step 3: Exchange code
  const tokenRes = await axios.post(TESLA_OAUTH_TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: OAUTH_CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    redirect_uri: FAKE_REDIRECT_URI
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  })

  const tokenData = tokenRes.data

  // 有了 ownerapi 的 token 后，再用它换 fleet-api 的 token
  const fleetTokenRes = await axios.post(TESLA_OAUTH_TOKEN_URL, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: TESLA_CLIENT_ID,
    client_secret: TESLA_CLIENT_SECRET,
    subject_token: tokenData.access_token,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    audience: TESLA_AUDIENCE
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  })

  return fleetTokenRes.data
}

/**
 * 获取 Tesla 用户信息
 */
async function getTeslaUserInfo(accessToken) {
  try {
    const res = await axios.get(`${TESLA_API_BASE}/api/1/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000
    })
    return res.data?.response || {}
  } catch (err) {
    console.warn('[getTeslaUserInfo] 获取失败:', err.message)
    return {}
  }
}

/**
 * 保存用户 token 到数据库
 */
async function saveUserTokens(openid, data) {
  const userRes = await db.collection('users').where({ openid }).get()
  if (userRes.data.length > 0) {
    await db.collection('users').where({ openid }).update({
      data: { ...data, gmt_modified: db.serverDate() }
    })
  } else {
    await db.collection('users').add({
      data: { openid, ...data, gmt_create: db.serverDate(), gmt_modified: db.serverDate() }
    })
  }
}

/**
 * 生成 PKCE code_verifier (86 字符)
 */
function generateCodeVerifier() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  let result = ''
  const bytes = crypto.randomBytes(86)
  for (let i = 0; i < 86; i++) {
    result += chars[bytes[i] % chars.length]
  }
  return result
}

/**
 * 生成 PKCE code_challenge (SHA256 base64url)
 */
function generateCodeChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest()
  return hash.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * 从 HTML 表单中提取隐藏字段
 */
function extractFormFields(html) {
  const fields = {}
  if (!html || typeof html !== 'string') return fields

  // 匹配 <input type="hidden" name="xxx" value="yyy" />
  const regex = /<input[^>]*type=["']hidden["'][^>]*>/gi
  let match
  while ((match = regex.exec(html)) !== null) {
    const nameMatch = match[0].match(/name=["']([^"']+)["']/i)
    const valueMatch = match[0].match(/value=["']([^"']*)["']/i)
    if (nameMatch) {
      fields[nameMatch[1]] = valueMatch ? valueMatch[1] : ''
    }
  }

  return fields
}