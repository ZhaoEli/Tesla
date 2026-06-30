// 云函数入口文件
const cloud = require('wx-server-sdk')
const config = require('../../config')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * 云函数：获取微信 access_token
 * 用于服务端调用微信 API（如获取手机号等）
 * access_token 有效期 2 小时，建议配合缓存使用
 */
exports.main = async (event, context) => {
  const { appId, appSecret } = config.wx

  try {
    const res = await cloud.openapi.auth.getAccessToken({
      grantType: 'client_credential',
      appid: appId,
      secret: appSecret
    })

    return {
      code: 0,
      data: {
        accessToken: res.access_token,
        expiresIn: res.expires_in
      }
    }
  } catch (err) {
    console.error('获取 access_token 失败:', err)
    return {
      code: -1,
      message: '获取 access_token 失败',
      error: err
    }
  }
}